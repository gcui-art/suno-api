/**
 * Test script: Human-like UI-based song generation
 * 
 * This script:
 * 1. Connects to existing Chrome via CDP
 * 2. Uses ghost-cursor for human-like mouse movements
 * 3. Fills forms via paste (human-realistic)
 * 4. Lets invisible hCaptcha work naturally
 * 5. Only handles visible hCaptcha if it appears
 * 
 * Usage: node test-ui-generate.js [section_number|all]
 * Example: node test-ui-generate.js 5     - Generate section 5
 * Example: node test-ui-generate.js 1-5   - Generate sections 1 through 5
 * Example: node test-ui-generate.js all   - Generate all sections
 */

const { chromium } = require('rebrowser-playwright-core');
const { createCursor } = require('ghost-cursor-playwright');
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exit } = require('process');

// Manually load .env.local since dotenv v17 has issues
function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const match = trimmed.match(/^([^=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    }
  } catch (e) {
    // File doesn't exist, ignore
  }
}

loadEnvFile(path.join(__dirname, '.env.local'));

// Configuration
const CDP_ENDPOINT = process.env.CDP_BROWSER_ENDPOINT || 'http://127.0.0.1:9222';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Debug: show if keys loaded
if (GEMINI_API_KEY) {
  console.log('✓ GEMINI_API_KEY loaded from .env.local');
} else if (OPENAI_API_KEY) {
  console.log('✓ OPENAI_API_KEY loaded from .env.local');
} else {
  console.log('⚠️  No API keys found! Set GEMINI_API_KEY or OPENAI_API_KEY');
}

// Load song data
const SONGS_FILE = '/Users/ericjung/Documents/Code/suno-api/music-powerless.json';

// Blue console output helper
const blueLog = (msg) => console.log('\x1b[34m%s\x1b[0m', msg);
const greenLog = (msg) => console.log('\x1b[32m%s\x1b[0m', msg);
const yellowLog = (msg) => console.log('\x1b[33m%s\x1b[0m', msg);

// Human-like delay helper (realistic range)
async function humanDelay(minMs = 500, maxMs = 1500) {
  const delay = Math.random() * (maxMs - minMs) + minMs;
  await new Promise(r => setTimeout(r, delay));
}

// Longer delay between songs (5-15 seconds like real humans)
async function betweenSongsDelay() {
  const delay = Math.random() * 3000 + 2000; // 2-5 seconds
  yellowLog(`⏳ Waiting ${(delay / 1000).toFixed(1)}s before next song (human-like delay)...`);
  await new Promise(r => setTimeout(r, delay));
}

// Track last mouse position for smooth movements
let lastMouseX = 500;
let lastMouseY = 400;

// Generate bezier control points for curved mouse path
function generateBezierPath(startX, startY, endX, endY, steps = 20) {
  const points = [];
  
  // Random control points for natural curve (not direct line)
  const cp1x = startX + (endX - startX) * 0.25 + (Math.random() - 0.5) * 100;
  const cp1y = startY + (endY - startY) * 0.25 + (Math.random() - 0.5) * 100;
  const cp2x = startX + (endX - startX) * 0.75 + (Math.random() - 0.5) * 100;
  const cp2y = startY + (endY - startY) * 0.75 + (Math.random() - 0.5) * 100;
  
  for (let t = 0; t <= 1; t += 1 / steps) {
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    
    const x = mt3 * startX + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * endX;
    const y = mt3 * startY + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * endY;
    
    // Add tiny random jitter for human imperfection
    points.push({
      x: x + (Math.random() - 0.5) * 2,
      y: y + (Math.random() - 0.5) * 2
    });
  }
  
  return points;
}

// Move mouse along a curved path (human-like)
async function humanMouseMove(page, targetX, targetY) {
  const path = generateBezierPath(lastMouseX, lastMouseY, targetX, targetY);
  
  for (const point of path) {
    await page.mouse.move(point.x, point.y);
    // Variable speed - slower at ends, faster in middle
    const delay = 5 + Math.random() * 15;
    await new Promise(r => setTimeout(r, delay));
  }
  
  lastMouseX = targetX;
  lastMouseY = targetY;
}

// Randomly fidget the mouse (small movements like humans do)
async function randomFidget(page) {
  if (Math.random() < 0.3) { // 30% chance to fidget
    const fidgetX = lastMouseX + (Math.random() - 0.5) * 50;
    const fidgetY = lastMouseY + (Math.random() - 0.5) * 50;
    await page.mouse.move(fidgetX, fidgetY);
    lastMouseX = fidgetX;
    lastMouseY = fidgetY;
    await humanDelay(100, 300);
  }
}

async function connectToBrowser() {
  console.log(`Connecting to browser via CDP: ${CDP_ENDPOINT}`);
  
  const endpointsToTry = [
    CDP_ENDPOINT,
    `http://[::1]:9222`,
    `http://localhost:9222`
  ];
  
  for (const endpoint of endpointsToTry) {
    try {
      console.log(`Trying: ${endpoint}`);
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      console.log(`✓ Connected via ${endpoint}`);
      return browser;
    } catch (e) {
      console.log(`  Failed: ${e.message}`);
    }
  }
  throw new Error('Could not connect to browser. Is Chrome running with --remote-debugging-port=9222?');
}

// Click helper with human-like behavior
// Uses curved mouse path and random click position
async function ghostClick(cursor, element, page) {
  try {
    const box = await element.boundingBox();
    if (box) {
      // Calculate a random position within the element (not always center)
      const paddingX = box.width * 0.3;
      const paddingY = box.height * 0.3;
      const clickX = box.x + box.width / 2 + (Math.random() - 0.5) * paddingX;
      const clickY = box.y + box.height / 2 + (Math.random() - 0.5) * paddingY;
      
      // Move mouse along curved path to target
      await humanMouseMove(page, clickX, clickY);
      
      // Small pause before clicking (like real human)
      await humanDelay(50, 150);
      
      // Click at current position
      await page.mouse.click(clickX, clickY);
      
      // Maybe fidget after click
      await randomFidget(page);
      
      return true;
    } else {
      // No bounding box, just click
      await element.click();
      return true;
    }
  } catch (e) {
    // Fallback to regular click
    console.log(`  (Click fallback: ${e.message})`);
    try {
      await element.click();
    } catch (e2) {
      console.log(`  (Click failed: ${e2.message})`);
      return false;
    }
    return true;
  }
}

// Paste text with human-like focus behavior - clears existing text first
async function pasteText(cursor, locator, text, page) {
  // Click into the field with human-like mouse movement
  await ghostClick(cursor, locator, page);
  await humanDelay(150, 350);
  
  // Clear existing text (Cmd+A, then type over)
  await locator.clear();
  await humanDelay(100, 200);
  
  // Paste the text
  await locator.fill(text);
  
  // Small pause after typing, maybe fidget
  await humanDelay(200, 500);
  await randomFidget(page);
}

// Solve captcha with AI (Gemini preferred, OpenAI fallback)
// If promptImageBase64 is provided, sends two images: prompt/sample image first, then grid
async function solveCaptchaWithAI(screenshotBase64, promptText, challengeWidth, challengeHeight, headerHeight = 150, promptImageBase64 = null) {
  const instructionText = `You're given 2 images. 
  
  1. Prompt (what you need to solve) + most often a sample image. 
  2. A grid image with 3x3 choices. :
1 2 3 
4 5 6 
7 8 9 

${promptText}

NOTE: The images are designed to trick you, so they may be confusing, surreal, or hyper-stylized. If a sample image is provided at the top above the grid, spend 50% of your energy understanding it correctly first. There usually are 2, 3, or 4 right answers (but not always). Almost never more than 4.

IMPORTANT: Respond ONLY with comma-separated numbers (e.g., "1, 4, 7"). No other text.`;

  let answer = '';
  let thoughtSummary = '';
  const startTime = Date.now();

  if (GEMINI_API_KEY) {
    blueLog('🌟 Solving with Gemini 3 Pro (streaming with thoughts)...');
    
    // Build parts array - optionally include prompt image first
    const parts = [{ text: instructionText }];
    if (promptImageBase64) {
      parts.push({ inlineData: { mimeType: "image/png", data: promptImageBase64 } });
      blueLog('  📷 Sending prompt/sample image');
    }
    parts.push({ inlineData: { mimeType: "image/png", data: screenshotBase64 } });
    blueLog('  📷 Sending grid image');
    
    // Use streaming endpoint to get thoughts in real-time
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse',
      {
        contents: [{
          parts: parts
        }],
        generationConfig: {
          thinkingConfig: { 
            thinkingLevel: "low",
            includeThoughts: true
          },
          temperature: 1.0
        }
      },
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 120000,
        responseType: 'text' // Get raw SSE text
      }
    );
    
    // Parse SSE response
    const lines = response.data.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') break;
        try {
          const chunk = JSON.parse(jsonStr);
          const candidates = chunk?.candidates;
          if (candidates && candidates.length > 0) {
            const content = candidates[0]?.content;
            if (content?.parts) {
              for (const part of content.parts) {
                if (part.text) {
                  if (part.thought) {
                    // Stream thoughts to console
                    process.stdout.write(`\x1b[90m${part.text}\x1b[0m`); // Gray for thoughts
                    thoughtSummary += part.text;
                  } else {
                    answer += part.text;
                  }
                }
              }
            }
          }
        } catch (e) {
          // Ignore parse errors on incomplete chunks
        }
      }
    }
    
    if (thoughtSummary) {
      console.log('\n'); // New line after thoughts
      blueLog(`💭 Thinking summary: ${thoughtSummary.substring(0, 200)}${thoughtSummary.length > 200 ? '...' : ''}`);
    }
    
    answer = answer.trim();
  } else if (OPENAI_API_KEY) {
    blueLog('🤖 Solving with OpenAI GPT-5.2...');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    
    const response = await openai.responses.create({
      model: "gpt-5.2",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: instructionText },
          { type: "input_image", image_url: `data:image/png;base64,${screenshotBase64}` }
        ]
      }],
      text: { format: { type: "text" }, verbosity: "low" },
      reasoning: { effort: "high", summary: "auto" },
      tools: [],
      store: false
    });
    
    if (response.output) {
      for (const item of response.output) {
        if (item.type === 'message' && item.content) {
          for (const content of item.content) {
            if (content.type === 'output_text') {
              answer = content.text?.trim() || '';
              break;
            }
          }
        }
      }
    }
  } else {
    throw new Error('No AI API key available (GEMINI_API_KEY or OPENAI_API_KEY)');
  }

  blueLog(`✅ AI responded (${Date.now() - startTime}ms): "${answer}"`);

  // Parse numbers
  const numbers = answer
    .replace(/[^0-9,\s]/g, '')
    .split(/[,\s]+/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => n >= 1 && n <= 9);

  if (numbers.length === 0) {
    throw new Error(`Invalid response: "${answer}"`);
  }

  // Convert to coordinates
  const gridHeight = challengeHeight - headerHeight;
  const cellWidth = challengeWidth / 3;
  const cellHeight = gridHeight / 3;

  return numbers.map(num => {
    const row = Math.floor((num - 1) / 3);
    const col = (num - 1) % 3;
    return {
      x: Math.round(col * cellWidth + cellWidth / 2),
      y: Math.round(headerHeight + row * cellHeight + cellHeight / 2)
    };
  });
}

// Handle visible hCaptcha ONLY if it appears (don't poll aggressively)
async function handleVisibleCaptcha(page, cursor) {
  const { execSync } = require('child_process');
  
  console.log('  [handleVisibleCaptcha] Starting...');
  
  try {
    // Check if visible hCaptcha challenge appeared - try multiple selectors
    const selectors = [
      'iframe[title*="hCaptcha challenge"]',
      'iframe[src*="hcaptcha-assets-prod.suno.com"]',
      'iframe[src*="hcaptcha.com/captcha"]',
      'iframe[src*="newassets.hcaptcha.com"]'
    ];
    
    let challengeIframe = null;
    for (const selector of selectors) {
      challengeIframe = await page.$(selector);
      if (challengeIframe) {
        console.log(`  [handleVisibleCaptcha] Found captcha iframe with: ${selector}`);
        break;
      }
    }
    
    if (!challengeIframe) {
      console.log('  [handleVisibleCaptcha] No captcha iframe found with any selector');
      return false;
    }

    const box = await challengeIframe.boundingBox();
    if (!box) {
      console.log('  [handleVisibleCaptcha] Could not get bounding box');
      return false;
    }
    console.log(`  [handleVisibleCaptcha] Bounding box: ${JSON.stringify(box)}`);

    // Take screenshot of challenge (same as test-captcha)
    const timestamp = Date.now();
    const screenshotPath = `captcha-screenshots/ui-captcha-${timestamp}.png`;
    console.log(`  [handleVisibleCaptcha] Taking screenshot to ${screenshotPath}...`);
    
    await page.screenshot({
      path: screenshotPath,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height }
    });
    console.log(`📸 Screenshot saved: ${screenshotPath}`);

    // EXACT SAME PROCEDURE AS test-captcha:
    console.log('🔧 Using ffmpeg to split image...');
    
    // Get image dimensions using ffprobe
    const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${screenshotPath}"`;
    console.log(`  [handleVisibleCaptcha] Running: ${probeCmd}`);
    const dims = execSync(probeCmd, { encoding: 'utf8' }).trim().split(',');
    const imgWidth = parseInt(dims[0]);
    const imgHeight = parseInt(dims[1]);
    console.log(`📐 Original dimensions: ${imgWidth}x${imgHeight}`);
    
    const promptHeight = 240;
    const gridHeight = imgHeight - promptHeight;
    
    // Use the SAME file names as test-captcha
    const promptPath = 'captcha-screenshots/prompt-and-sample.png';
    const gridPath = 'captcha-screenshots/grid.png';
    
    // Crop top part (prompt and sample)
    const cropPromptCmd = `ffmpeg -y -i "${screenshotPath}" -vf "crop=${imgWidth}:${promptHeight}:0:0" "${promptPath}"`;
    console.log(`  [handleVisibleCaptcha] Running: ${cropPromptCmd}`);
    execSync(cropPromptCmd + ' 2>/dev/null');
    console.log(`📸 Saved prompt/sample: ${promptPath} (${imgWidth}x${promptHeight})`);
    
    // Crop bottom part (grid)
    const cropGridCmd = `ffmpeg -y -i "${screenshotPath}" -vf "crop=${imgWidth}:${gridHeight}:0:${promptHeight}" "${gridPath}"`;
    console.log(`  [handleVisibleCaptcha] Running: ${cropGridCmd}`);
    execSync(cropGridCmd + ' 2>/dev/null');
    console.log(`📸 Saved grid: ${gridPath} (${imgWidth}x${gridHeight})`);
    
    // Verify files exist
    if (!fs.existsSync(gridPath)) {
      throw new Error(`grid.png was not created at ${gridPath}`);
    }
    if (!fs.existsSync(promptPath)) {
      throw new Error(`prompt-and-sample.png was not created at ${promptPath}`);
    }
    console.log('  [handleVisibleCaptcha] Both files created successfully');
    
    // Read cropped images as base64
    const promptBase64 = fs.readFileSync(promptPath).toString('base64');
    const gridBase64 = fs.readFileSync(gridPath).toString('base64');
    console.log(`  [handleVisibleCaptcha] Loaded base64: prompt=${promptBase64.length} chars, grid=${gridBase64.length} chars`);

    // Try to get prompt text from the page
    let promptText = 'Click on all images that match';
    try {
      const frame = page.frameLocator('iframe[src*="hcaptcha-assets-prod.suno.com"], iframe[src*="hcaptcha.com/captcha"]');
      const promptElement = frame.locator('.prompt-text').first();
      promptText = await promptElement.textContent({ timeout: 2000 }) || promptText;
    } catch (e) {
      console.log(`  [handleVisibleCaptcha] Could not get prompt text: ${e.message}`);
    }

    console.log(`📋 Challenge: "${promptText}"`);
    console.log('\n🤖 Sending to Gemini...\n');

    // Screenshot is at retina resolution (e.g., 800x1200) but clicks use CSS pixels (e.g., 320x490)
    // Calculate scale factor and use CSS dimensions for coordinate calculation
    const scale = imgHeight / box.height;
    const cssPromptHeight = promptHeight / scale;
    
    console.log(`📐 Scale factor: ${scale.toFixed(2)}x (screenshot ${imgWidth}x${imgHeight} -> CSS ${box.width}x${box.height})`);
    console.log(`📐 Header: ${promptHeight}px screenshot -> ${cssPromptHeight.toFixed(0)}px CSS`);

    // Solve with AI - use CSS pixel dimensions for coordinate calculation
    const coordinates = await solveCaptchaWithAI(
      gridBase64,
      promptText,
      box.width,        // CSS width
      box.height,       // CSS height
      cssPromptHeight,  // Header in CSS pixels
      promptBase64
    );

    console.log(`🖱️ Clicking ${coordinates.length} positions...`);

    // Click each position - coordinates are now in CSS pixels
    for (const coord of coordinates) {
      const clickX = box.x + coord.x;
      const clickY = box.y + coord.y;
      console.log(`  CSS coord (${coord.x.toFixed(0)}, ${coord.y.toFixed(0)}) -> screen (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
      await page.mouse.move(clickX, clickY, { steps: 10 });
      await humanDelay(100, 200);
      await page.mouse.click(clickX, clickY);
      await humanDelay(300, 600);
    }

    // Click verify button - try multiple approaches
    await humanDelay(500, 1000);
    let verifyClicked = false;
    
    // Try different frame selectors
    const frameSelectors = [
      'iframe[src*="hcaptcha-assets-prod.suno.com"]',
      'iframe[title*="hCaptcha challenge"]',
      'iframe[src*="hcaptcha.com/captcha"]'
    ];
    
    // Try different button selectors
    const buttonSelectors = [
      '.button-submit',
      '[role="button"][title="Verify Answers"]',
      '[aria-label="Verify Answers"]',
      'div.button-submit.button',
      '.button-submit.button'
    ];
    
    for (const frameSel of frameSelectors) {
      if (verifyClicked) break;
      try {
        const frame = page.frameLocator(frameSel);
        for (const btnSel of buttonSelectors) {
          try {
            const verifyBtn = frame.locator(btnSel).first();
            await verifyBtn.click({ timeout: 2000 });
            console.log(`✅ Clicked verify button (frame: ${frameSel}, btn: ${btnSel})`);
            verifyClicked = true;
            break;
          } catch {}
        }
      } catch {}
    }
    
    if (!verifyClicked) {
      console.log('⚠️ Could not find verify button with any selector');
    }

    // Wait for captcha to process
    await humanDelay(2000, 3000);
    return true;
    
  } catch (error) {
    console.error(`  [handleVisibleCaptcha] ERROR: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

async function generateSongViaUI(page, cursor, songParams) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`🎵 GENERATING: ${songParams.title}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Set up response listener
  let generatedSongIds = [];
  let responseReceived = false;
  let responseError = null;

  const responseHandler = async (response) => {
    const url = response.url();
    if (url.includes('/api/generate/v2')) {
      greenLog('\n📡 Captured generate API response!');
      console.log('📦 Response status:', response.status());

      try {
        const responseBody = await response.json();

        if (responseBody.clips) {
          generatedSongIds = responseBody.clips.map(clip => ({
            id: clip.id,
            status: clip.status,
            title: clip.title
          }));
          greenLog(`🎵 Generated ${generatedSongIds.length} songs!`);
        } else if (responseBody.id) {
          generatedSongIds = [{ id: responseBody.id, status: responseBody.status, title: responseBody.title }];
          greenLog(`🎵 Generated song: ${responseBody.id}`);
        } else if (responseBody.detail) {
          responseError = responseBody.detail;
          console.log('⚠️ API error:', responseBody.detail);
        }

        responseReceived = true;
      } catch (e) {
        console.log('Could not parse response:', e.message);
      }
    }
  };

  page.on('response', responseHandler);

  try {
    // Step 1: Switch to Custom mode if needed
    blueLog('📝 Step 1: Switching to Custom mode...');
    try {
      // Check if Custom button exists and is NOT active
      const customButton = page.locator('button:has-text("Custom")').first();
      const isVisible = await customButton.isVisible({ timeout: 2000 });
      if (isVisible) {
        // Check if it has the "active" class
        const hasActiveClass = await customButton.evaluate(el => el.classList.contains('active'));
        if (!hasActiveClass) {
          await ghostClick(cursor, customButton, page);
          blueLog('  ✓ Switched to Custom mode');
          await humanDelay(500, 1000);
        } else {
          blueLog('  ✓ Already in Custom mode');
        }
      }
    } catch (e) {
      blueLog(`  (Custom mode check: ${e.message})`);
    }

    // Step 1b: Check model version and switch to v4.5+ if needed
    blueLog('\n📝 Step 1b: Checking model version...');
    try {
      // Find the version selector button (shows current version like "v5" or "v4.5+")
      const versionButton = page.locator('button:has-text("v5"), button:has-text("v4.5")').first();
      const versionVisible = await versionButton.isVisible({ timeout: 3000 });
      
      if (versionVisible) {
        const versionText = await versionButton.textContent();
        blueLog(`  Current version: ${versionText.trim()}`);
        
        // If it's v5, we need to change to v4.5+
        if (versionText.includes('v5')) {
          blueLog('  Switching to v4.5+...');
          await ghostClick(cursor, versionButton, page);
          await humanDelay(300, 500);
          
          // Wait for dropdown menu to appear and click v4.5+
          const v45Option = page.locator('button:has-text("v4.5+")').first();
          await v45Option.waitFor({ state: 'visible', timeout: 3000 });
          await ghostClick(cursor, v45Option, page);
          blueLog('  ✓ Switched to v4.5+');
          await humanDelay(300, 500);
        } else {
          blueLog('  ✓ Already on v4.5+');
        }
      }
    } catch (e) {
      blueLog(`  (Version check skipped: ${e.message})`);
    }

    // Step 2: Fill lyrics (if not instrumental)
    blueLog('\n📝 Step 2: Filling lyrics...');
    const lyricsSelectors = [
      'textarea[placeholder*="Write some lyrics"]',
      'textarea[placeholder*="lyrics"]',
      'textarea[placeholder*="instrumental"]'
    ];

    let lyricsTextarea = null;
    for (const selector of lyricsSelectors) {
      try {
        const el = page.locator(selector).first();
        await el.waitFor({ state: 'visible', timeout: 3000 });
        lyricsTextarea = el;
        break;
      } catch {}
    }

    if (lyricsTextarea) {
      if (songParams.description_lyrics && !songParams.is_instrumental) {
        await pasteText(cursor, lyricsTextarea, songParams.description_lyrics, page);
        blueLog('  ✓ Lyrics pasted');
      } else {
        // Instrumental or empty lyrics - CLEAR the field to remove any leftover text
        await ghostClick(cursor, lyricsTextarea, page);
        await humanDelay(100, 200);
        await lyricsTextarea.clear();
        blueLog('  ✓ Lyrics cleared (instrumental)');
      }
    }
    await humanDelay(300, 700);

    // Step 3: Fill style/tags
    blueLog('\n📝 Step 3: Filling style/tags...');
    
    // Try multiple strategies to find the style textarea
    // Strategy 1: By placeholder text patterns
    const styleSelectors = [
      'textarea[placeholder*="war song"]',
      'textarea[placeholder*="synthwave"]',
      'textarea[placeholder*="style"]',
      'textarea[placeholder*="genre"]',
      'textarea[placeholder*="bpm"]',
      'textarea[placeholder*="BPM"]'
    ];

    let styleFilled = false;
    
    for (const selector of styleSelectors) {
      try {
        const styleTextarea = page.locator(selector).first();
        await styleTextarea.waitFor({ state: 'visible', timeout: 1500 });
        await pasteText(cursor, styleTextarea, songParams.description_music, page);
        blueLog(`  ✓ Style/tags pasted (selector: ${selector})`);
        styleFilled = true;
        break;
      } catch {}
    }
    
    // Strategy 2: If no specific selector worked, try finding the second textarea
    // (first is usually lyrics, second is usually style in Suno's UI)
    if (!styleFilled) {
      try {
        blueLog('  Trying fallback: second visible textarea...');
        const allTextareas = await page.locator('textarea').all();
        let visibleCount = 0;
        for (const ta of allTextareas) {
          if (await ta.isVisible()) {
            visibleCount++;
            if (visibleCount === 2) {
              await pasteText(cursor, ta, songParams.description_music, page);
              blueLog('  ✓ Style/tags pasted (fallback: 2nd textarea)');
              styleFilled = true;
              break;
            }
          }
        }
      } catch (e) {
        console.log(`  Fallback failed: ${e.message}`);
      }
    }
    
    if (!styleFilled) {
      yellowLog('  ⚠️ WARNING: Could not find style textarea!');
    }
    await humanDelay(300, 700);

    // Step 4: Fill title
    blueLog('\n📝 Step 4: Filling title...');
    const titleInputs = await page.locator('input[placeholder*="Song Title"]').all();
    for (const input of titleInputs) {
      if (await input.isVisible()) {
        await pasteText(cursor, input, songParams.title, page);
        blueLog('  ✓ Title pasted');
        break;
      }
    }
    await humanDelay(300, 700);

    // IMPORTANT: IF EXIT IS NOT COMMENTED OUT, IT MEANS I DONT WANT TO SUBMIT ANYTHING RIGHT NOW SO NEVER UNCOMMENT EXIT()
    // Uncomment the next 2 lines to observe mouse movements without submitting
    yellowLog('\n🔍 OBSERVATION MODE: Exiting before submission. Watch the mouse movements above!');
    // exit();
    
    // Step 5: Click Create button
    blueLog('\n🚀 Step 5: Clicking Create...');
    const createButton = page.locator('button[aria-label="Create song"]');
    await createButton.waitFor({ state: 'visible', timeout: 10000 });

    // Wait for button to be enabled
    const startWait = Date.now();
    while (!(await createButton.isEnabled())) {
      if (Date.now() - startWait > 10000) {
        throw new Error('Create button not enabled after 10s');
      }
      await page.waitForTimeout(200);
    }

    await ghostClick(cursor, createButton, page);
    greenLog('  ✓ Create button clicked!');

    // Step 6: Wait for response, handle captcha if triggered
    blueLog('\n⏳ Step 6: Waiting for response...');

    const timeout = 90000;
    const startTime = Date.now();
    let captchaTriggered = false;
    let captchaSolved = false;

    // Listen for hCaptcha console message
    const consoleHandler = (msg) => {
      const text = msg.text();
      if (text.includes('captcha required') || text.includes('awaiting verification')) {
        captchaTriggered = true;
        blueLog('  🔒 hCaptcha triggered, waiting for auto-solve...');
      }
    };
    page.on('console', consoleHandler);

    try {
      while (!responseReceived && (Date.now() - startTime) < timeout) {
        // Check if hCaptcha iframe appeared (backup detection)
        if (!captchaTriggered) {
          try {
            const captchaIframe = await page.$('iframe[src*="hcaptcha-assets-prod.suno.com"], iframe[src*="hcaptcha.com"]');
            if (captchaIframe) {
              captchaTriggered = true;
              blueLog('  🔒 hCaptcha iframe detected, waiting for auto-solve...');
            }
          } catch {}
        }

        // If captcha was triggered, wait 4s then check if it actually auto-solved
        if (captchaTriggered && !captchaSolved) {
          blueLog('  ⏳ Giving invisible hCaptcha 4 seconds to auto-solve...');
          await new Promise(resolve => setTimeout(resolve, 4000));
          
          // The REAL test: did we get an API response? If yes, captcha was auto-solved
          if (responseReceived) {
            blueLog('  ✅ Invisible hCaptcha auto-solved! (got API response)');
            captchaSolved = true;
          } else {
            // No response yet = captcha NOT auto-solved, need to solve it
            blueLog('  ❌ Captcha NOT auto-solved (no API response yet)');
            
            // Look for visible challenge iframe
            try {
              // Try multiple selectors for the challenge popup
              const challengeSelectors = [
                'iframe[src*="hcaptcha-assets-prod.suno.com"]',
                'iframe[title*="hCaptcha challenge"]',
                'iframe[src*="hcaptcha.com/captcha"]',
                'iframe[src*="newassets.hcaptcha.com"]'
              ];
              
              let visibleChallenge = null;
              for (const selector of challengeSelectors) {
                const iframe = await page.$(selector);
                if (iframe) {
                  const isVis = await iframe.isVisible().catch(() => false);
                  if (isVis) {
                    visibleChallenge = iframe;
                    blueLog(`  Found visible challenge: ${selector}`);
                    break;
                  }
                }
              }
              
              if (visibleChallenge) {
                blueLog('  🤖 Sending captcha to Gemini...');
                const solved = await handleVisibleCaptcha(page, cursor);
                if (solved) {
                  blueLog('  ✅ Captcha solved by Gemini!');
                }
              } else {
                yellowLog('  ⚠️ Captcha triggered but no visible challenge found - waiting...');
              }
            } catch (e) {
              console.log(`  (Captcha check error: ${e.message})`);
            }
            captchaSolved = true;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      page.off('console', consoleHandler);
    }

    if (responseError) {
      throw new Error(`API error: ${responseError}`);
    }

    if (!responseReceived) {
      throw new Error('No response received within timeout');
    }

    greenLog('\n✅ Song generation initiated successfully!');
    return generatedSongIds;

  } finally {
    page.off('response', responseHandler);
  }
}

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  const sectionArg = args[0] || '1';

  // TEST MODE: Run captcha solver on a specific image
  if (sectionArg === 'test-captcha') {
    const { execSync } = require('child_process');
    const testImage = args[1] || '/Users/ericjung/Documents/Code/suno-api/captcha-screenshots/captcha-screenshot-1766846575685.png';
    const testPrompt = args[2] || 'pick all animals that live in a similar habitat as the sample animal';
    
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         GEMINI CAPTCHA SOLVER TEST                        ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    
    console.log(`📸 Image: ${testImage}`);
    console.log(`📋 Prompt: "${testPrompt}"`);
    console.log('');
    
    if (!fs.existsSync(testImage)) {
      throw new Error(`Image not found: ${testImage}`);
    }
    
    // Use ffmpeg to get image dimensions and crop
    // Screenshot is 760x1000: top 760x240 = prompt/sample, bottom 760x760 = grid
    console.log('🔧 Using ffmpeg to split image...');
    
    // Get image dimensions using ffprobe
    const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${testImage}"`;
    const dims = execSync(probeCmd, { encoding: 'utf8' }).trim().split(',');
    const imgWidth = parseInt(dims[0]);
    const imgHeight = parseInt(dims[1]);
    console.log(`📐 Original dimensions: ${imgWidth}x${imgHeight}`);
    
    const promptHeight = 240;
    const gridHeight = imgHeight - promptHeight;
    
    const promptPath = 'captcha-screenshots/prompt-and-sample.png';
    const gridPath = 'captcha-screenshots/grid.png';
    
    // Crop top part (prompt and sample): crop=width:height:x:y
    execSync(`ffmpeg -y -i "${testImage}" -vf "crop=${imgWidth}:${promptHeight}:0:0" "${promptPath}" 2>/dev/null`);
    console.log(`📸 Saved prompt/sample: ${promptPath} (${imgWidth}x${promptHeight})`);
    
    // Crop bottom part (grid)
    execSync(`ffmpeg -y -i "${testImage}" -vf "crop=${imgWidth}:${gridHeight}:0:${promptHeight}" "${gridPath}" 2>/dev/null`);
    console.log(`📸 Saved grid: ${gridPath} (${imgWidth}x${gridHeight})`);
    
    // Read cropped images as base64
    const promptBase64 = fs.readFileSync(promptPath).toString('base64');
    const gridBase64 = fs.readFileSync(gridPath).toString('base64');
    
    console.log('\n🤖 Sending to Gemini...\n');
    
    const startTime = Date.now();
    const coordinates = await solveCaptchaWithAI(gridBase64, testPrompt, imgWidth, gridHeight, 0, promptBase64);
    const elapsed = Date.now() - startTime;
    
    const cellSize = gridHeight / 3;
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`⏱️  Total time: ${elapsed}ms`);
    console.log(`🎯 Selected cells: ${coordinates.map((c) => {
      const row = Math.floor(c.y / cellSize);
      const col = Math.floor(c.x / cellSize);
      return row * 3 + col + 1;
    }).join(', ')}`);
    console.log(`📍 Coordinates: ${JSON.stringify(coordinates)}`);
    return;
  }

  // Load songs
  if (!fs.existsSync(SONGS_FILE)) {
    throw new Error(`Songs file not found: ${SONGS_FILE}`);
  }
  const songs = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));

  // Determine which sections to generate
  let sectionsToGenerate = [];
  
  if (sectionArg === 'all') {
    sectionsToGenerate = songs.map(s => s.section);
  } else if (sectionArg.includes('-')) {
    const [start, end] = sectionArg.split('-').map(Number);
    for (let i = start; i <= end; i++) {
      sectionsToGenerate.push(i);
    }
  } else {
    sectionsToGenerate = [parseInt(sectionArg, 10)];
  }

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         SUNO UI GENERATION - HUMAN-LIKE MODE              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\nSections to generate: ${sectionsToGenerate.join(', ')}`);
  console.log(`Total songs: ${sectionsToGenerate.length}`);
  console.log('\nFeatures:');
  console.log('  ✓ Ghost cursor for human-like mouse movements');
  console.log('  ✓ Realistic delays between songs (5-15s)');
  console.log('  ✓ Invisible hCaptcha allowed to work naturally');
  console.log('  ✓ Only solves visible captcha if it appears\n');

  // Ensure screenshot directory exists
  if (!fs.existsSync('captcha-screenshots')) {
    fs.mkdirSync('captcha-screenshots');
  }

  // Connect to browser
  const browser = await connectToBrowser();
  const context = browser.contexts()[0];

  // Find or create page
  let page = (await context.pages()).find(p => p.url().includes('/create'));
  if (!page) {
    console.log('Opening new tab for suno.com/create...');
    page = await context.newPage();
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000); // Wait for page to fully load
  } else {
    console.log('Using existing /create tab');
  }

  // Create ghost cursor for human-like movements
  const cursor = await createCursor(page);
  console.log('✓ Ghost cursor initialized\n');

  // Close any popups
  try {
    await page.getByLabel('Close').click({ timeout: 2000 });
    await humanDelay(500, 1000);
  } catch {}

  // Generate each section
  const results = [];
  
  for (let i = 0; i < sectionsToGenerate.length; i++) {
    const sectionNum = sectionsToGenerate[i];
    const song = songs.find(s => s.section === sectionNum);
    
    if (!song) {
      console.log(`⚠️ Section ${sectionNum} not found in songs file`);
      continue;
    }

    try {
      const songIds = await generateSongViaUI(page, cursor, song);
      results.push({
        section: sectionNum,
        title: song.title,
        songIds,
        success: true
      });
    } catch (e) {
      console.error(`\n❌ Error generating section ${sectionNum}:`, e.message);
      results.push({
        section: sectionNum,
        title: song.title,
        error: e.message,
        success: false
      });
    }

    // Human-like delay between songs (except for last one)
    if (i < sectionsToGenerate.length - 1) {
      await betweenSongsDelay();
    }
  }

  // Final summary
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    FINAL RESULTS                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`❌ Failed: ${failed.length}`);
    failed.forEach(f => console.log(`   - Section ${f.section}: ${f.error}`));
  }
  
  console.log('\nGenerated songs:');
  successful.forEach(r => {
    console.log(`  Section ${r.section}: ${r.title}`);
    r.songIds.forEach(s => console.log(`    → ${s.id}`));
  });

  // Save results to file
  const resultsFile = `generation-results-${Date.now()}.json`;
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\n📄 Results saved to: ${resultsFile}`);

  // Cleanly disconnect from CDP (don't close the browser, just detach)
  // This prevents the "session closed" warnings on exit
  try {
    await browser.disconnect();
  } catch (e) {
    // Ignore disconnect errors - browser stays open
  }
}

// Run
main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
