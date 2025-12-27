/**
 * Test script: UI-based song generation with network interception
 * 
 * This script:
 * 1. Connects to existing Chrome via CDP
 * 2. Navigates the Suno UI in a human-like way
 * 3. Fills in song parameters (title, style/tags, lyrics)
 * 4. Clicks Create and intercepts the network response to get song IDs
 * 5. Handles hCaptcha if it appears (using OpenAI GPT-5.2)
 */

const { chromium } = require('rebrowser-playwright-core');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Configuration
const CDP_ENDPOINT = process.env.CDP_BROWSER_ENDPOINT || 'http://127.0.0.1:9222';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Test song parameters - WITH LYRICS (lyric prompt)
const TEST_SONG_WITH_LYRICS = {
  title: 'Windstorm Prayer, Becoming',
  tags: '126 BPM. Epic spiritual climax—cinematic desert trance with ritual percussion. Begin with threatening low drones and chanting-like synth pads (no words), under tense darbuka and deep taiko. Build in three waves: desert (dry textures, sand hiss), wind (rising whooshes, swirling strings), sun (bright brass and choir pad). At the transformation, unleash a full simum: aggressive percussion, wide choir, and soaring ney. After the storm, cut suddenly to near-silence with a single pure chord—alive, changed.',
  lyrics: 'Wordless choir only: sustained vowel drones and a rising 3-note motif, like prayer becoming wind; no language, no syllables beyond "ah/oh."',
  instrumental: false
};

// Test song parameters - INSTRUMENTAL (no lyrics)
const TEST_SONG_INSTRUMENTAL = {
  title: 'Gold Made, Gifts Given',
  tags: '94 BPM. Miraculous clarity: cinematic awe with monastic calm. Start with simple piano and soft strings, then reveal alchemy with a bright, crystalline bell motif and warm brass halo. Keep it dignified, not flashy—wonder shown, not explained. Use a gentle processional rhythm as gold is divided, hinting at generosity\'s law. Let the alchemist depart with a fading theme, leaving Santiago\'s solo melody to continue toward the Pyramids. End in moonlit majesty—slow, open, weeping chords.',
  lyrics: '', // Empty for instrumental
  instrumental: true
};

// Blue console output helper
const blueLog = (msg) => console.log('\x1b[34m%s\x1b[0m', msg);

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

async function humanDelay(min = 100, max = 300) {
  const delay = Math.random() * (max - min) + min;
  await new Promise(r => setTimeout(r, delay));
}

async function pasteText(locator, text) {
  // Click to focus, then fill (equivalent to paste)
  await locator.click();
  await humanDelay(50, 100);
  await locator.fill(text);
  await humanDelay(100, 200);
}

async function solveCaptchaWithOpenAI(screenshotBase64, promptText, challengeWidth, challengeHeight, headerHeight = 150) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set - cannot solve captcha');
  }
  
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  
  blueLog('\n🤖 ════════════════════════════════════════════════════════');
  blueLog('🤖 OPENAI GPT-5.2 CAPTCHA SOLVING');
  blueLog('🤖 ════════════════════════════════════════════════════════');
  
  const instructionText = `Images are 
1 2 3 
4 5 6 
7 8 9 

${promptText}

Respond in comma separated numbers`;

  blueLog(`📝 Instruction: "${promptText}"`);
  
  const startTime = Date.now();
  
  const response = await openai.responses.create({
    model: "gpt-5.2",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: instructionText },
          { type: "input_image", image_url: `data:image/png;base64,${screenshotBase64}` }
        ]
      }
    ],
    text: { format: { type: "text" }, verbosity: "low" },
    reasoning: { effort: "low", summary: "auto" },
    tools: [],
    store: false
  });
  
  // Extract answer
  let answer = '';
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
  
  blueLog(`✅ GPT-5.2 responded (${Date.now() - startTime}ms): "${answer}"`);
  
  // Parse numbers
  const numbers = answer.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= 9);
  
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

async function handleCaptcha(page) {
  blueLog('\n🔒 Checking for hCaptcha...');
  
  // Look for hCaptcha iframe
  const captchaFrame = page.frameLocator('iframe[src*="hcaptcha"]').first();
  
  try {
    // Wait briefly to see if captcha appears
    await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 3000 });
    blueLog('⚠️ hCaptcha detected!');
  } catch {
    blueLog('✓ No hCaptcha detected');
    return false;
  }
  
  // Find the challenge iframe
  const challengeFrame = page.frameLocator('iframe[src*="hcaptcha.com/captcha"]').first();
  
  let attempts = 0;
  const maxAttempts = 5;
  
  while (attempts < maxAttempts) {
    attempts++;
    blueLog(`\n🔄 Captcha solving attempt ${attempts}/${maxAttempts}`);
    
    try {
      // Wait for challenge to load
      await page.waitForTimeout(2000);
      
      // Get the challenge iframe element to get dimensions
      const challengeIframe = await page.$('iframe[src*="hcaptcha.com/captcha"]');
      if (!challengeIframe) {
        blueLog('Challenge iframe not found, waiting...');
        await page.waitForTimeout(2000);
        continue;
      }
      
      const box = await challengeIframe.boundingBox();
      if (!box) {
        blueLog('Could not get challenge dimensions');
        continue;
      }
      
      // Take screenshot of the challenge area
      const screenshotPath = `captcha-screenshots/ui-captcha-${Date.now()}.png`;
      await page.screenshot({ 
        path: screenshotPath,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height }
      });
      
      const screenshotBase64 = fs.readFileSync(screenshotPath).toString('base64');
      
      // Try to get the prompt text from the challenge
      let promptText = 'Click on all images that match the description';
      try {
        const promptElement = challengeFrame.locator('.prompt-text, [class*="prompt"]').first();
        promptText = await promptElement.textContent({ timeout: 2000 }) || promptText;
      } catch {
        blueLog('Could not extract prompt text, using default');
      }
      
      // Solve with OpenAI
      const coordinates = await solveCaptchaWithOpenAI(
        screenshotBase64,
        promptText,
        box.width,
        box.height,
        150
      );
      
      blueLog(`📍 Clicking ${coordinates.length} positions...`);
      
      // Click each position in the challenge iframe
      for (const coord of coordinates) {
        await page.mouse.click(box.x + coord.x, box.y + coord.y);
        await humanDelay(200, 400);
      }
      
      // Click verify/submit button
      await page.waitForTimeout(500);
      const verifyButton = challengeFrame.locator('button:has-text("Verify"), button:has-text("Submit"), .button-submit').first();
      try {
        await verifyButton.click({ timeout: 2000 });
      } catch {
        blueLog('Could not find verify button, trying to continue...');
      }
      
      // Wait to see if captcha is solved
      await page.waitForTimeout(3000);
      
      // Check if captcha is still visible
      try {
        await page.waitForSelector('iframe[src*="hcaptcha.com/captcha"]', { timeout: 2000 });
        blueLog('⚠️ Captcha still visible, retrying...');
      } catch {
        blueLog('✅ Captcha appears to be solved!');
        return true;
      }
      
    } catch (e) {
      blueLog(`❌ Error during captcha solving: ${e.message}`);
    }
  }
  
  throw new Error('Failed to solve captcha after max attempts');
}

async function generateViaUI(songParams) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🎵 UI-BASED SONG GENERATION TEST');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const browser = await connectToBrowser();
  const context = browser.contexts()[0];
  
  // Find or create a page for /create
  let page = (await context.pages()).find(p => p.url().includes('/create'));
  if (!page) {
    console.log('Opening new tab for suno.com/create...');
    page = await context.newPage();
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  } else {
    console.log('Using existing /create tab');
  }
  
  // Close any popups
  try {
    await page.getByLabel('Close').click({ timeout: 2000 });
  } catch {}
  
  // Set up response listener to capture the generate API response
  let generatedSongIds = [];
  let responseReceived = false;
  let requestPayload = null;
  
  // Listen for the response (this doesn't interfere with the request)
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/generate/v2')) {
      console.log('\n📡 Captured generate API response!');
      console.log('📦 Response status:', response.status());
      
      try {
        const responseBody = await response.json();
        
        if (responseBody.clips) {
          generatedSongIds = responseBody.clips.map(clip => ({
            id: clip.id,
            status: clip.status,
            title: clip.title,
            audio_url: clip.audio_url,
            created_at: clip.created_at
          }));
          console.log('🎵 Generated songs:', JSON.stringify(generatedSongIds, null, 2));
        } else if (responseBody.id) {
          generatedSongIds = [{ 
            id: responseBody.id, 
            status: responseBody.status,
            title: responseBody.title 
          }];
          console.log('🎵 Generated song:', responseBody.id);
        } else if (responseBody.detail) {
          console.log('⚠️ API returned error:', responseBody.detail);
        }
        
        responseReceived = true;
      } catch (e) {
        console.log('Could not parse response:', e.message);
      }
    }
  });
  
  // Also capture the request to see what was sent
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/generate/v2')) {
      console.log('\n📤 Captured generate API request!');
      try {
        requestPayload = request.postDataJSON();
        console.log('📝 Request payload:', JSON.stringify({
          title: requestPayload.title,
          tags: requestPayload.tags?.substring(0, 50) + '...',
          prompt: requestPayload.prompt?.substring(0, 50) + '...',
          make_instrumental: requestPayload.make_instrumental,
          override_fields: requestPayload.override_fields,
          mv: requestPayload.mv
        }, null, 2));
      } catch {}
    }
  });
  
  // Step 1: Find and switch to Custom mode if needed
  console.log('\n📝 Step 1: Locating form fields...');
  
  // The UI has a Custom mode toggle - look for it
  try {
    const customButton = page.locator('button:has-text("Custom")').first();
    await customButton.click({ timeout: 3000 });
    console.log('  ✓ Switched to Custom mode');
    await humanDelay(300, 500);
  } catch {
    console.log('  (Already in Custom mode or button not found)');
  }
  
  // Step 2: Fill in the lyrics/prompt (exact placeholder from Suno UI)
  console.log('\n📝 Step 2: Filling lyrics...');
  const lyricsSelectors = [
    'textarea[placeholder*="Write some lyrics or a prompt"]',
    'textarea[placeholder*="lyrics"]',
    'textarea[placeholder*="instrumental"]'
  ];
  
  let lyricsTextarea = null;
  for (const selector of lyricsSelectors) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: 3000 });
      lyricsTextarea = el;
      console.log(`  Found lyrics textarea: ${selector}`);
      break;
    } catch {}
  }
  
  if (lyricsTextarea) {
    if (songParams.lyrics) {
      await pasteText(lyricsTextarea, songParams.lyrics);
      console.log('  ✓ Lyrics pasted');
    } else {
      console.log('  (No lyrics - instrumental mode)');
    }
  } else {
    throw new Error('Could not find lyrics textarea');
  }
  await humanDelay(200, 400);
  
  // Step 3: Fill in the style/tags (exact placeholder from Suno UI)
  console.log('\n📝 Step 3: Filling style/tags...');
  const styleSelectors = [
    'textarea[placeholder*="war song, synthwave"]',
    'textarea[placeholder*="war song"]',
    'textarea[placeholder*="synthwave"]',
    'textarea[placeholder*="bpm"]',
    'textarea[placeholder*="gabber"]'
  ];
  
  let styleFilled = false;
  for (const selector of styleSelectors) {
    try {
      const styleTextarea = page.locator(selector).first();
      await styleTextarea.waitFor({ state: 'visible', timeout: 2000 });
      await pasteText(styleTextarea, songParams.tags);
      console.log(`  ✓ Style/tags pasted (using: ${selector})`);
      styleFilled = true;
      break;
    } catch {}
  }
  
  if (!styleFilled) {
    console.log('  ⚠️ Style textarea not found (may be in simple mode)');
  }
  await humanDelay(200, 400);
  
  // Step 4: Fill in the title (use exact placeholder from user's HTML)
  console.log('\n📝 Step 4: Filling title...');
  
  // There are multiple inputs with this placeholder - find the VISIBLE one
  const titleInputs = await page.locator('input[placeholder="Song Title (Optional)"]').all();
  let titleFilled = false;
  
  for (const input of titleInputs) {
    const isVisible = await input.isVisible();
    if (isVisible) {
      await pasteText(input, songParams.title);
      console.log('  ✓ Title pasted');
      titleFilled = true;
      break;
    }
  }
  
  if (!titleFilled) {
    console.log('  ⚠️ No visible title input found');
  }
  await humanDelay(200, 400);
  
  // Step 5: Toggle instrumental mode if needed
  if (songParams.instrumental) {
    console.log('\n🎹 Step 5: Enabling instrumental mode...');
    // Look for the instrumental toggle - it's usually a switch or checkbox
    const instrumentalSelectors = [
      'button:has-text("Instrumental")',
      '[aria-label*="instrumental" i]',
      'label:has-text("Instrumental")',
      'input[type="checkbox"][name*="instrumental" i]',
      '[data-testid*="instrumental" i]'
    ];
    
    let instrumentalToggled = false;
    for (const selector of instrumentalSelectors) {
      try {
        const toggle = page.locator(selector).first();
        await toggle.waitFor({ state: 'visible', timeout: 2000 });
        await toggle.click();
        console.log(`  ✓ Instrumental mode enabled (using: ${selector})`);
        instrumentalToggled = true;
        break;
      } catch {}
    }
    
    if (!instrumentalToggled) {
      // Try finding by text content in a more general way
      try {
        const instrumentalText = page.getByText('Instrumental', { exact: false }).first();
        await instrumentalText.click({ timeout: 2000 });
        console.log('  ✓ Instrumental mode enabled (by text)');
        instrumentalToggled = true;
      } catch {}
    }
    
    if (!instrumentalToggled) {
      console.log('  ⚠️ Could not find instrumental toggle');
    }
    await humanDelay(200, 400);
  }
  
  // Step 6: Click the Create button
  console.log('\n🚀 Step 6: Clicking Create...');
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
  
  await createButton.click();
  console.log('  ✓ Create button clicked!');
  
  // Step 7: Wait for response or handle captcha
  console.log('\n⏳ Step 7: Waiting for response...');
  
  const timeout = 60000; // 60 seconds
  const startTime = Date.now();
  
  while (!responseReceived && (Date.now() - startTime) < timeout) {
    // Check for captcha
    const captchaDetected = await handleCaptcha(page);
    if (captchaDetected) {
      console.log('Captcha was solved, continuing to wait for response...');
    }
    
    await page.waitForTimeout(1000);
  }
  
  if (!responseReceived) {
    console.log('⚠️ No response received within timeout');
  }
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('📊 RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Generated Songs:', JSON.stringify(generatedSongIds, null, 2));
  
  return generatedSongIds;
}

// Main execution
(async () => {
  try {
    // Ensure screenshot directory exists
    if (!fs.existsSync('captcha-screenshots')) {
      fs.mkdirSync('captcha-screenshots');
    }
    
    // Parse command line args
    const args = process.argv.slice(2);
    const testType = args[0] || 'lyrics'; // 'lyrics', 'instrumental', or 'both'
    
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           SUNO UI GENERATION TEST SUITE                   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`\nTest mode: ${testType}`);
    console.log('Usage: node test-ui-generate.js [lyrics|instrumental|both]\n');
    
    const results = {};
    
    if (testType === 'lyrics' || testType === 'both') {
      console.log('\n🎤 ═══════════════════════════════════════════════════════════');
      console.log('🎤 TEST 1: WITH LYRICS (Wordless choir prompt)');
      console.log('🎤 ═══════════════════════════════════════════════════════════');
      results.withLyrics = await generateViaUI(TEST_SONG_WITH_LYRICS);
      console.log('\n✅ Lyrics test complete!');
      console.log('Song IDs:', results.withLyrics.map(s => s.id));
      
      // Wait a bit between tests if running both
      if (testType === 'both') {
        console.log('\n⏳ Waiting 5 seconds before next test...\n');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    
    if (testType === 'instrumental' || testType === 'both') {
      console.log('\n🎹 ═══════════════════════════════════════════════════════════');
      console.log('🎹 TEST 2: INSTRUMENTAL (Gold Made, Gifts Given)');
      console.log('🎹 ═══════════════════════════════════════════════════════════');
      results.instrumental = await generateViaUI(TEST_SONG_INSTRUMENTAL);
      console.log('\n✅ Instrumental test complete!');
      console.log('Song IDs:', results.instrumental.map(s => s.id));
    }
    
    // Final summary
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    FINAL RESULTS                          ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(JSON.stringify(results, null, 2));
    
  } catch (e) {
    console.error('\n❌ Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
