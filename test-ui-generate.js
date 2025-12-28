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

// Configuration
const CDP_ENDPOINT = process.env.CDP_BROWSER_ENDPOINT || 'http://127.0.0.1:9222';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Load song data
const SONGS_FILE = './fift-shades-of-grey-music.json';

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
  const delay = Math.random() * 10000 + 5000; // 5-15 seconds
  yellowLog(`⏳ Waiting ${(delay / 1000).toFixed(1)}s before next song (human-like delay)...`);
  await new Promise(r => setTimeout(r, delay));
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
// Note: ghost-cursor has issues with CDP connections, so we use direct Playwright clicks
// but add random position offsets for more human-like behavior
async function ghostClick(cursor, element, page) {
  try {
    const box = await element.boundingBox();
    if (box) {
      // Calculate a slightly random position within the element (not always center)
      const paddingX = box.width * 0.2;
      const paddingY = box.height * 0.2;
      const offsetX = -paddingX / 2 + Math.random() * paddingX;
      const offsetY = -paddingY / 2 + Math.random() * paddingY;
      
      // Click with random offset from center
      await element.click({ position: { x: box.width / 2 + offsetX, y: box.height / 2 + offsetY } });
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
  await ghostClick(cursor, locator, page);
  await humanDelay(100, 200);
  // Clear existing text first, then fill
  await locator.clear();
  await humanDelay(50, 100);
  await locator.fill(text);
  await humanDelay(200, 400);
}

// Solve captcha with AI (Gemini preferred, OpenAI fallback)
async function solveCaptchaWithAI(screenshotBase64, promptText, challengeWidth, challengeHeight, headerHeight = 150) {
  const instructionText = `Images are arranged in a 3x3 grid:
1 2 3 
4 5 6 
7 8 9 

${promptText}

NOTE: The images are designed to trick you, so they may be confusing, surreal, or hyper-stylized. If a sample image is provided at the top above the grid, spend 50% of your energy understanding it correctly first. There usually are 2 or 3 right answers (but not always). Almost never more than 4.

IMPORTANT: Respond ONLY with comma separated numbers (e.g., "1, 4, 7"). No other text.`;

  let answer = '';
  const startTime = Date.now();

  if (GEMINI_API_KEY) {
    blueLog('🌟 Solving with Gemini 3 Pro...');
    
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
      {
        contents: [{
          parts: [
            { text: instructionText },
            { inlineData: { mimeType: "image/png", data: screenshotBase64 } }
          ]
        }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "high" },
          temperature: 1.0
        }
      },
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );
    
    const candidates = response.data?.candidates;
    if (candidates && candidates.length > 0) {
      const content = candidates[0]?.content;
      if (content?.parts) {
        for (const part of content.parts) {
          if (part.text) {
            answer = part.text.trim();
            break;
          }
        }
      }
    }
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
  // Check if visible hCaptcha challenge appeared
  const challengeIframe = await page.$('iframe[src*="hcaptcha.com/captcha"]');
  if (!challengeIframe) {
    return false; // No visible captcha
  }

  blueLog('\n⚠️ Visible hCaptcha challenge detected! Solving...');

  const box = await challengeIframe.boundingBox();
  if (!box) {
    console.log('Could not get challenge dimensions');
    return false;
  }

  // Take screenshot of challenge
  const timestamp = Date.now();
  const screenshotPath = `captcha-screenshots/ui-captcha-${timestamp}.png`;
  await page.screenshot({
    path: screenshotPath,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height }
  });
  blueLog(`📸 Screenshot saved: ${screenshotPath}`);

  const screenshotBase64 = fs.readFileSync(screenshotPath).toString('base64');

  // Try to get prompt text
  let promptText = 'Click on all images that match';
  try {
    const frame = page.frameLocator('iframe[src*="hcaptcha.com/captcha"]');
    const promptElement = frame.locator('.prompt-text').first();
    promptText = await promptElement.textContent({ timeout: 2000 }) || promptText;
  } catch {}

  blueLog(`📋 Challenge: "${promptText}"`);

  // Solve with AI
  const coordinates = await solveCaptchaWithAI(
    screenshotBase64,
    promptText,
    box.width,
    box.height,
    150
  );

  blueLog(`🖱️ Clicking ${coordinates.length} positions...`);

  // Click each position with human-like delays
  for (const coord of coordinates) {
    await page.mouse.move(box.x + coord.x, box.y + coord.y, { steps: 10 });
    await humanDelay(100, 200);
    await page.mouse.click(box.x + coord.x, box.y + coord.y);
    await humanDelay(300, 600);
  }

  // Click verify button
  await humanDelay(500, 1000);
  try {
    const frame = page.frameLocator('iframe[src*="hcaptcha.com/captcha"]');
    const verifyBtn = frame.locator('.button-submit').first();
    await verifyBtn.click({ timeout: 3000 });
    blueLog('✅ Clicked verify button');
  } catch {
    blueLog('⚠️ Could not find verify button');
  }

  // Wait for captcha to process
  await humanDelay(2000, 3000);
  return true;
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
      const customButton = page.locator('button:has-text("Custom")').first();
      const isVisible = await customButton.isVisible({ timeout: 2000 });
      if (isVisible) {
        await ghostClick(cursor, customButton, page);
        blueLog('  ✓ Switched to Custom mode');
        await humanDelay(500, 1000);
      }
    } catch {
      blueLog('  (Already in Custom mode)');
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
        blueLog('  (Instrumental - no lyrics)');
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
    // exit()
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

    // Step 6: Wait for response naturally (no aggressive polling)
    blueLog('\n⏳ Step 6: Waiting for response...');
    blueLog('  (Letting invisible hCaptcha work if needed...)');

    const timeout = 90000; // 90 seconds
    const startTime = Date.now();
    let captchaChecked = false;

    while (!responseReceived && (Date.now() - startTime) < timeout) {
      // Only check for VISIBLE captcha after 5 seconds (give invisible time to work)
      if (!captchaChecked && (Date.now() - startTime) > 5000) {
        const solved = await handleVisibleCaptcha(page, cursor);
        if (solved) {
          blueLog('Visible captcha was solved, waiting for response...');
        }
        captchaChecked = true;
      }

      // Check again after 15 seconds if still waiting
      if (captchaChecked && (Date.now() - startTime) > 15000 && (Date.now() - startTime) < 20000) {
        await handleVisibleCaptcha(page, cursor);
      }

      await page.waitForTimeout(1000);
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
