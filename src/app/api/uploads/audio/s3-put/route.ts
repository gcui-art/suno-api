import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, optionsResponse } from "@/app/api/sunoProxyResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/uploads/audio/s3-put
 * 由本机（国外、网络好）代替浏览器把音频 POST 到 Suno 的 S3 预签名地址，
 * 规避国内浏览器直传 suno-uploads.s3.amazonaws.com 的网络问题。
 *
 * multipart/form-data 入参：
 *  - file:      音频文件
 *  - s3_url:    createAudioUpload 返回的 S3 预签名 URL
 *  - s3_fields: createAudioUpload 返回的 fields（JSON 字符串）
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const s3Url = form.get("s3_url")?.toString();
    const s3FieldsRaw = form.get("s3_fields")?.toString();

    if (!(file instanceof Blob) || !s3Url || !s3FieldsRaw) {
      return errorResponse(new Error("file, s3_url, s3_fields are required"));
    }

    let fields: Record<string, string>;
    try {
      fields = JSON.parse(s3FieldsRaw);
    } catch {
      return errorResponse(new Error("s3_fields must be valid JSON"));
    }

    const filename = (file as File).name || "audio";
    const buildForm = () => {
      const s3Form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        s3Form.append(key, String(value));
      }
      s3Form.append("file", file, filename);
      return s3Form;
    };

    let resp = await fetch(s3Url, { method: "POST", body: buildForm() });

    // 主地址失败时，尝试带 region 的 S3 端点（个别情况下更稳）
    if (!resp.ok) {
      const regional = regionalS3Url(s3Url, fields);
      if (regional && regional !== s3Url) {
        resp = await fetch(regional, { method: "POST", body: buildForm() });
      }
    }

    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      return errorResponse(
        new Error(`S3 upload failed (${resp.status}): ${detail || "unknown storage error"}`)
      );
    }

    return jsonResponse({ ok: true });
  } catch (error: any) {
    console.error("Error putting audio to S3:", error);
    return errorResponse(error);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}

/** 把 xxx.s3.amazonaws.com 换成带 region 的 xxx.s3.<region>.amazonaws.com */
function regionalS3Url(url: string, fields: Record<string, string>): string {
  const region = awsRegionFromCredential(fields);
  if (!region) return "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (!parsed.hostname.endsWith(".s3.amazonaws.com")) return "";
  parsed.hostname = parsed.hostname.replace(
    ".s3.amazonaws.com",
    `.s3.${region}.amazonaws.com`
  );
  return parsed.toString();
}

function awsRegionFromCredential(fields: Record<string, string>): string {
  const key = Object.keys(fields).find((k) => k.toLowerCase() === "x-amz-credential");
  if (!key) return "";
  const match = fields[key].match(/\/\d{8}\/([a-z0-9-]+)\/s3\/aws4_request/i);
  return match?.[1] ?? "";
}
