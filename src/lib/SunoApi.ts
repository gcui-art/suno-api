import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { sleep } from "@/lib/utils";

const logger = pino();


export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  duration?: string; // Duration of the audio
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.suno.ai';
  private static CLERK_BASE_URL: string = 'https://clerk.suno.com';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;

  constructor(cookie: string) {
    const cookieJar = new CookieJar();
    const randomUserAgent = new UserAgent(/Chrome/).random().toString();
    this.client = wrapper(axios.create({
      jar: cookieJar,
      withCredentials: true,
      headers: {
        'User-Agent': randomUserAgent,
        'Cookie': cookie
      }
    }))
    this.client.interceptors.request.use((config) => {
      if (this.currentToken) { // Use the current token status
        config.headers['Authorization'] = `Bearer ${this.currentToken}`;
      }
      return config;
    });
  }

  public async init(): Promise<SunoApi> {
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_clerk_js_version=4.72.1`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl);
    if (!sessionResponse?.data?.response?.['last_active_session_id']) {
      throw new Error("Failed to get session id, you may need to update the SUNO_COOKIE");
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response['last_active_session_id'];
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error("Session ID is not set. Cannot renew token.");
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_clerk_js_version=4.72.0-snapshot.vc141245`;
    // Renew session token
    const renewResponse = await this.client.post(renewUrl);
    logger.info("KeepAlive...\n");
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data['jwt'];
    console.log("newToken:===\n\n", newToken);
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns 
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    wait_audio: boolean = false,
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
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
  public async custom_generate(
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
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
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
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      {
        timeout: 10000, // 10 seconds timeout
      },
    );
    logger.info("generateSongs Response:\n" + JSON.stringify(response.data, null, 2));
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    const songIds = response.data['clips'].map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          audio => audio.status === 'streaming' || audio.status === 'complete'
        );
        if (allCompleted) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      await this.keepAlive(true);
      return response.data['clips'].map((audio: any) => ({
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
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(`${SunoApi.BASE_URL}/api/generate/lyrics/`, { prompt });
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(`${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`);
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(`${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`);
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   * 
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = "",
    continueAt: string = "0",
    tags: string = "",
    title: string = ""
  ): Promise<AudioInfo> {
    const response = await this.client.post(`${SunoApi.BASE_URL}/api/generate/v2/`, {
      continue_clip_id: audioId,
      continue_at: continueAt,
      mv: "chirp-v3-0",
      prompt: prompt,
      tags: tags,
      title: ""
    });
    return response.data;
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter(line => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(songIds?: string[]): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = `${SunoApi.BASE_URL}/api/feed/`;
    if (songIds) {
      url = `${url}?ids=${songIds.join(',')}`;
    }
    logger.info("Get audio status: " + url);
    const response = await this.client.get(url, {
      // 3 seconds timeout
      timeout: 3000
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

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/billing/info/`);
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage,
    };
  }
}

const newSunoApi = async (cookie: string) => {
  const sunoApi = new SunoApi(cookie);
  return await sunoApi.init();
}

if (!process.env.SUNO_COOKIE) {
  console.log("Environment does not contain SUNO_COOKIE.", process.env)
}

export const sunoApi = newSunoApi(process.env.SUNO_COOKIE || '');
