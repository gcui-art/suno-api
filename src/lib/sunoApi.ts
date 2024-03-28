import axios from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
const logger = pino();


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
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
  logger.info(`Sleeping for ${timeout / 1000} seconds`);

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
    SunoApi.sid = sid; // 保存会话ID以备后用

    // 使用会话ID获取JWT令牌
    const exchangeTokenUrl = exchangeTokenUrlTemplate.replace('{sid}', sid);
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
    logger.info("KeepAlive...\n");
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
    const startTime = Date.now();
    const audios = this.generateSongs(prompt, false, undefined, undefined, make_instrumental, wait_audio);
    const costTime = Date.now() - startTime;
    logger.info("Generate Response:\n" + JSON.stringify(audios, null, 2));
    logger.info("Cost time: " + costTime);
    return audios;
  }

  /**
   * Generates custom audio based on provided parameters.
   * 
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public static async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    wait_audio: boolean = false,
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(prompt, true, tags, title, make_instrumental, wait_audio);
    const costTime = Date.now() - startTime;
    logger.info("Custom Generate Response:\n" + JSON.stringify(audios, null, 2));
    logger.info("Cost time: " + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   * 
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
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
    logger.info("generateSongs payload:\n" + JSON.stringify({
      prompt: prompt,
      isCustom: isCustom,
      tags: tags,
      title: title,
      make_instrumental: make_instrumental,
      wait_audio: wait_audio,
      payload: payload,
    }, null, 2));
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
    logger.info("generateSongs Response:\n" + JSON.stringify(response.data, null, 2));
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio === true) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await SunoApi.get(songIds);
        const allCompleted = response.every(
          audio => audio.status === 'streaming' || audio.status === 'complete'
        );
        if (allCompleted) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
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
     * Processes the lyrics (prompt) from the audio metadata into a more readable format.
     * @param prompt The original lyrics text.
     * @returns The processed lyrics text.
     */
  private static parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter(line => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    const formattedLyrics = lines.join('\n');

    return formattedLyrics;
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public static async get(songIds?: string[]): Promise<AudioInfo[]> {
    const authToken = await this.getAuthToken();
    let url = `${SunoApi.baseUrl}/api/feed/`;
    if (songIds) {
      url = `${url}?ids=${songIds.join(',')}`;
    }
    logger.info("Get audio status: " + url);
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'User-Agent': SunoApi.userAgent,
      },
      timeout: 3000, // 3 seconds timeout
    });

    const audios = response.data;
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

  public static async get_credits(): Promise<object> {
    const authToken = await this.getAuthToken();
    const response = await axios.get(`${SunoApi.baseUrl}/api/billing/info/`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'User-Agent': SunoApi.userAgent,
      },
    });
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage,
    };
  }
}

export default SunoApi;