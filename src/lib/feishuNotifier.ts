import axios, { AxiosInstance } from 'axios';
import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import FormData from 'form-data';
import pino from 'pino';

const logger = pino();

function describeFeishuError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { code?: number; msg?: string } | undefined;
    if (data?.msg) return `${data.code ?? error.response?.status}: ${data.msg}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const IMAGE_UPLOAD_URL = 'https://open.feishu.cn/open-apis/im/v1/images';

interface TenantTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
}

interface ImageUploadResponse {
  code: number;
  msg?: string;
  data?: {
    image_key?: string;
  };
}

interface WebhookPayload {
  msg_type: 'text' | 'image';
  content: Record<string, string>;
  timestamp?: string;
  sign?: string;
}

export interface FeishuNotification {
  title: string;
  text: string;
  imagePath?: string;
}

export class FeishuNotifier {
  private readonly client: AxiosInstance;

  constructor(
    private readonly webhookUrl = process.env.FEISHU_BOT_WEBHOOK,
    private readonly botSecret = process.env.FEISHU_BOT_SECRET,
    private readonly appId = process.env.FEISHU_APP_ID,
    private readonly appSecret = process.env.FEISHU_APP_SECRET
  ) {
    this.client = axios.create({ timeout: 30_000 });
  }

  public get enabled(): boolean {
    return Boolean(this.webhookUrl);
  }

  public async notify(notification: FeishuNotification): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    await this.sendText(`${notification.title}\n${notification.text}`);
    // 图片走 im/v1/images，需要自建应用开启「机器人」能力；
    // 失败时只降级掉截图，不能让文本通知一起被判为失败。
    try {
      const imageKey = await this.uploadImage(notification.imagePath);
      if (imageKey) {
        await this.sendImage(imageKey);
      }
    } catch (error) {
      logger.warn(`Feishu image notification skipped: ${describeFeishuError(error)}`);
    }
  }

  private async sendText(text: string): Promise<void> {
    await this.sendWebhook({
      msg_type: 'text',
      content: { text }
    });
  }

  private async sendImage(imageKey: string): Promise<void> {
    await this.sendWebhook({
      msg_type: 'image',
      content: { image_key: imageKey }
    });
  }

  private async sendWebhook(payload: WebhookPayload): Promise<void> {
    await this.client.post(this.webhookUrl as string, this.withSignature(payload));
  }

  private withSignature(payload: WebhookPayload): WebhookPayload {
    if (!this.botSecret) {
      return payload;
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      ...payload,
      timestamp,
      sign: this.createSign(timestamp)
    };
  }

  private createSign(timestamp: string): string {
    const stringToSign = `${timestamp}\n${this.botSecret}`;
    return createHmac('sha256', stringToSign).update('').digest('base64');
  }

  private async uploadImage(imagePath?: string): Promise<string | undefined> {
    if (!imagePath || !this.appId || !this.appSecret) {
      return undefined;
    }

    const tenantToken = await this.getTenantAccessToken();
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', createReadStream(imagePath));

    const response = await this.client.post<ImageUploadResponse>(IMAGE_UPLOAD_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${tenantToken}`
      }
    });
    this.assertFeishuSuccess(response.data, 'upload image');
    return response.data.data?.image_key;
  }

  private async getTenantAccessToken(): Promise<string> {
    const response = await this.client.post<TenantTokenResponse>(TENANT_TOKEN_URL, {
      app_id: this.appId,
      app_secret: this.appSecret
    });
    this.assertFeishuSuccess(response.data, 'get tenant access token');
    if (!response.data.tenant_access_token) {
      throw new Error('Feishu returned no tenant_access_token');
    }
    return response.data.tenant_access_token;
  }

  private assertFeishuSuccess(response: { code: number; msg?: string }, action: string): void {
    if (response.code === 0) {
      return;
    }
    throw new Error(`Feishu ${action} failed ${response.code}: ${response.msg ?? 'unknown error'}`);
  }
}
