import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { DEFAULT_MODEL, sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";
import fs from 'fs/promises';
import path from 'path';

export const maxDuration = 300; // 5 minutes for long-running process
export const dynamic = "force-dynamic";

// Import S3 functions from JavaScript module
const s3Module = require('@/lib/s3.js');
const { uploadFileToS3, uploadLocalFileToS3 } = s3Module;

async function downloadFile(url: string, filepath: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${url}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(filepath, buffer);
  return filepath;
}

async function waitForCompletion(api: any, songIds: string[], maxWaitTime: number = 180000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitTime) {
    const songs = await api.get(songIds);
    const allComplete = songs.every((song: any) => 
      song.status === 'complete' || song.status === 'error'
    );
    
    if (allComplete) {
      const elapsed = Date.now() - startTime;
      console.log('\x1b[32m%s\x1b[0m', `waitForCompletion: All songs completed in ${(elapsed / 1000).toFixed(1)} seconds.`);
      return songs;
    }
    
    // Wait 10-20 seconds before next check
    await new Promise(resolve => setTimeout(resolve, 10000 + Math.random() * 10000));
  }
  
  // Return whatever status we have after timeout
  const elapsed = Date.now() - startTime;
  console.log(`waitForCompletion: Timeout after ${(elapsed / 1000).toFixed(1)} seconds.`);
  return await api.get(songIds);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { 
      prompt, 
      gpt_description_prompt, 
      tags, 
      title, 
      make_instrumental, 
      model, 
      negative_tags,
      sb_id,
      section 
    } = body;
    
    // Validate required parameters
    if (!sb_id || !section) {
      return new NextResponse(JSON.stringify({ 
        error: 'sb_id and section are required' 
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    // Generate music (without waiting)
    const api = await sunoApi((await cookies()).toString());
    const audioInfo = await api.custom_generate(
      prompt || '', 
      tags, 
      title,
      Boolean(make_instrumental),
      model || DEFAULT_MODEL,
      false, // Don't wait for audio
      negative_tags,
      gpt_description_prompt
    );
    
    // Return immediately with submitted status
    const response = new NextResponse(JSON.stringify({
      message: 'Music generation started',
      status: 'submitted',
      ids: audioInfo.map(audio => audio.id)
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });

    // Continue processing in background
    (async () => {
      try {
        console.log('Background process: Waiting for completion...');
        
        // Wait for completion
        const songIds = audioInfo.map(audio => audio.id);
        const completedSongs = await waitForCompletion(api, songIds);
        
        // Ensure files directory exists
        const filesDir = path.join(process.cwd(), 'files');
        await fs.mkdir(filesDir, { recursive: true });
        
        // Process each completed song
        for (let i = 0; i < completedSongs.length; i++) {
          const song = completedSongs[i];
          const suffix = i === 0 ? 'a' : 'b';
          
          if (song.status === 'complete' && song.audio_url && song.image_url) {
            console.log(`Processing song ${i + 1}: ${song.id}`);
            
            // Download files
            const audioPath = path.join(filesDir, `${song.id}-audio.mp3`);
            const imagePath = path.join(filesDir, `${song.id}-image.jpg`);
            
            await downloadFile(song.audio_url, audioPath);
            await downloadFile(song.image_url, imagePath);
            
            // Upload to S3
            const audioS3Key = `immersive-audio/${sb_id}/${section}-music-${suffix}.mp3`;
            const imageS3Key = `immersive-audio/${sb_id}/${section}-cover-${suffix}.jpg`;
            
            const audioS3Url = await uploadLocalFileToS3(audioPath, audioS3Key);
            const imageS3Url = await uploadLocalFileToS3(imagePath, imageS3Key);
            
            console.log(`Uploaded to S3: ${audioS3Url}, ${imageS3Url}`);
            
            // Clean up local files
            await fs.unlink(audioPath);
            await fs.unlink(imagePath);
          }
        }
        
        console.log('Background process completed successfully');
      } catch (error) {
        console.error('Background process error:', error);
      }
    })();
    
    return response;
    
  } catch (error: any) {
    console.error('Error in generate_and_upload:', error);
    return new NextResponse(JSON.stringify({ 
      error: error.message || 'Internal server error' 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
} 