import axios from 'axios';
import UserAgent from 'user-agents';



interface AudioInfo {
  id: string;
  title?: string;
  image_url?: string;
  lyric?: string;
  audio_url?: string;
  video_url?: string;
  created_at: string;
  model_name: string;
  gpt_description_prompt?: string;
  prompt?: string;
  status: string;
  type?: string;
  tags?: string;
  duration?: string;
}
/**
 * 暂停指定的秒数。
 * @param x 最小秒数。
 * @param y 最大秒数（可选）。
 */
const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  console.log(`Sleeping for ${timeout / 1000} seconds`);
  return new Promise(resolve => setTimeout(resolve, timeout));
}

class SunoApi {
  private static baseUrl: string = 'https://studio-api.suno.ai';
  private static clerkBaseUrl: string = 'https://clerk.suno.ai';
  private static cookie: string = process.env.SUNO_COOKIE || '';
  private static userAgent: string = new UserAgent().toString();
  private static sid: string | null = null;

  private static async getAuthToken(): Promise<string> {

    // 获取会话ID的URL
    const getSessionUrl = `${SunoApi.clerkBaseUrl}/v1/client?_clerk_js_version=4.70.5`;
    // 交换令牌的URL模板
    const exchangeTokenUrlTemplate = `${SunoApi.clerkBaseUrl}/v1/client/sessions/{sid}/tokens/api?_clerk_js_version=4.70.0`;

    // 获取会话ID
    const sessionResponse = await axios.get(getSessionUrl, {
      headers: {
        'User-Agent': SunoApi.userAgent,
        'Cookie': SunoApi.cookie,
      },
    });
    const sid = sessionResponse.data.response?.last_active_session_id;
    if (!sid) {
      throw new Error("Failed to get session id");
    }
    console.log(`Successfully retrieved session ID: ${sid}`);
    SunoApi.sid = sid; // 保存会话ID以备后用

    // 使用会话ID获取JWT令牌
    const exchangeTokenUrl = exchangeTokenUrlTemplate.replace('{sid}', sid);
    // console.log("Exchange Token URL:\n", exchangeTokenUrl);
    // console.log("Exchange User-Agent:\n", SunoApi.userAgent);
    // console.log("Exchange Cookie:\n", SunoApi.cookie);
    const tokenResponse = await axios.post(
      exchangeTokenUrl,
      {},
      {
        headers: {
          'User-Agent': SunoApi.userAgent,
          'Cookie': SunoApi.cookie,
        },
      },
    );
    console.log("Token Response:\n", JSON.stringify(tokenResponse.data, null, 2));

    return tokenResponse.data.jwt;
  }
  public static async KeepAlive(): Promise<void> {
    if (!SunoApi.sid) {
      throw new Error("Session ID is not set. Cannot renew token.");
    }
    // 续订会话令牌的URL
    const renewUrl = `${SunoApi.clerkBaseUrl}/v1/client/sessions/${SunoApi.sid}/tokens/api?_clerk_js_version=4.70.0`;
    // 续订会话令牌
    const renewResponse = await axios.post(
      renewUrl,
      {},
      {
        headers: {
          'User-Agent': SunoApi.userAgent,
          'Cookie': SunoApi.cookie,
        },
      },
    );
    console.log("Renew Response:\n", JSON.stringify(renewResponse.data, null, 2));
    await sleep(1, 2);
    const newToken = renewResponse.data.jwt;
    // 更新请求头中的Authorization字段，使用新的JWT令牌
    axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
  }

  public static async generate(
    prompt: string,
    make_instrumental: boolean = false,
    wait_audio: boolean = false,
  ): Promise<AudioInfo[]> {

    const audios = this.generateSongs(prompt, false, undefined, undefined, make_instrumental, wait_audio);
    console.log("Custom Generate Response:\n", JSON.stringify(audios, null, 2));
    return audios;
  }

  public static async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    wait_audio: boolean = false,
  ): Promise<AudioInfo[]> {

    const audios = await this.generateSongs(prompt, true, tags, title, make_instrumental, wait_audio);
    console.log("Custom Generate Response:\n", JSON.stringify(audios, null, 2));
    return audios;
  }

  private static async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    const authToken = await this.getAuthToken();
    const payload: any = {
      make_instrumental: make_instrumental == true,
      mv: "chirp-v3-0",
      prompt: "",
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    console.log("generateSongs payload:\n", {
      prompt: prompt,
      isCustom: isCustom,
      tags: tags,
      title: title,
      make_instrumental: make_instrumental,
      wait_audio: wait_audio,
      payload: payload,
    });
    const response = await axios.post(
      `${SunoApi.baseUrl}/api/generate/v2/`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'User-Agent': SunoApi.userAgent,
        },
        timeout: 10000, // 10 seconds timeout
      },
    );
    console.log("generateSongs Response:\n", JSON.stringify(response.data, null, 2));
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio === true) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(2, 4);
      while (Date.now() - startTime < 30000) {
        const response = await SunoApi.get(songIds);
        console.log("Waiting for audio Response:\n", JSON.stringify(response, null, 2));
        const allCompleted = response.every(
          audio => audio.status === 'streaming' || audio.status === 'complete'
        );
        if (allCompleted) {
          return response;
        }
        lastResponse = response;
        await sleep(2, 4);
        this.KeepAlive();
      }
      return lastResponse;
    } else {
      this.KeepAlive();
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        duration: audio.metadata.duration_formatted,
      }));
    }
  }
  /**
     * 将音频元数据中的歌词（prompt）处理成易于阅读的格式。
     * @param prompt 原始歌词文本。
     * @returns 处理后的歌词文本。
     */
  private static parseLyrics(prompt: string): string {
    // 假设原始歌词是以特定分隔符（例如，换行符）分隔的，我们可以将其转换为更易于阅读的格式。
    // 这里的实现可以根据实际的歌词格式进行调整。
    // 例如，如果歌词是以连续的文本形式存在，可能需要根据特定的标记（如句号、逗号等）来分割。
    // 下面的实现假设歌词已经是以换行符分隔的。

    // 使用换行符分割歌词，并确保移除空行。
    const lines = prompt.split('\n').filter(line => line.trim() !== '');

    // 将处理后的歌词行重新组合成一个字符串，每行之间用换行符分隔。
    // 可以在这里添加额外的格式化逻辑，如添加特定的标记或者处理特殊的行。
    const formattedLyrics = lines.join('\n');

    return formattedLyrics;
  }
  public static async get(songIds?: string[]): Promise<AudioInfo[]> {
    const authToken = await this.getAuthToken();
    let url = `${SunoApi.baseUrl}/api/feed/`;
    if (songIds) {
      url = `${url}?ids=${songIds.join(',')}`;
    }
    console.log("Get URL:\n", url);
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'User-Agent': SunoApi.userAgent,
      },
      timeout: 3000, // 3 seconds timeout
    });

    const audios = response.data;
    console.log("Get Response:\n", JSON.stringify(audios, null, 2));
    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt ? this.parseLyrics(audio.metadata.prompt) : "",
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration_formatted,
    }));
  }

  public static async get_limit(): Promise<number> {
    const authToken = await this.getAuthToken();
    const response = await axios.get(`${SunoApi.baseUrl}/api/billing/info/`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'User-Agent': SunoApi.userAgent,
      },
    });
    return response.data.total_credits_left;
  }
}

export default SunoApi;