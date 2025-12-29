const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { URL } = require("url"); // For URL validation

// ===================== CONFIG =====================
const MATCHES_API = "https://matric-api.vercel.app/api/today-matches";
const MAIN_FB_POST_ID = "100985439354836_841729738620283";
const FB_TOKEN = "EAFb7enAJEpABQU1a6tskVcb9q2v6wZCh9RU3ZBZAavjoYHObyq462oKiREZBxZBOS88KNh3apkZCB36TTodMOwkDSpJxBdHXViAZBXn0CMBKuYI4rEAk2ZCRGJ9pnQAJgaM31w6rW6m4lLP9OxMZCZBe3jv72nc2URB2xGshv2BheZCcrApMJ1HDC52pzA1UYogZAsGUzZAiY9grZB";
const TEAMS_LOGS_FILE = path.join(__dirname, "teams_logs.json");
const TELEGRAM_CONFIG = {
  botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
  chatId: "-1002181683719",
};
const FETCH_INTERVAL_MIN = 60; // minutes
// ===================================================

// ===================== HELPERS =====================
async function sendTelegramMessage(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`,
      {
        chat_id: TELEGRAM_CONFIG.chatId,
        text: message,
        parse_mode: "HTML",
      }
    );
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

function loadTeamsLogs() {
  if (!fs.existsSync(TEAMS_LOGS_FILE)) return [];
  try {
    const raw = fs.readFileSync(TEAMS_LOGS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveTeamsLogs(logs) {
  fs.writeFileSync(TEAMS_LOGS_FILE, JSON.stringify(logs, null, 2));
}

// Validate and normalize URL
function normalizeUrl(url) {
  if (!url) return "";
  try {
    const urlObj = new URL(url.trim());
    return urlObj.toString().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

// Validate image URL before uploading
async function validateImageUrl(url) {
  try {
    const response = await axios.head(url, { timeout: 5000 });
    const contentType = response.headers['content-type'];
    return contentType && contentType.startsWith('image/');
  } catch {
    return false;
  }
}

// Upload image to Facebook and return post ID
async function uploadLogoToFb(imageUrl, teamName) {
  try {
    // First validate the image URL
    const isValid = await validateImageUrl(imageUrl);
    if (!isValid) {
      throw new Error(`Invalid image URL: ${imageUrl}`);
    }

    const res = await axios.post(
      `https://graph.facebook.com/v19.0/me/photos`,
      null,
      {
        params: {
          url: imageUrl,
          published: false,
          access_token: FB_TOKEN,
        },
        timeout: 10000,
      }
    );
    
    if (!res.data?.id) {
      throw new Error("No post ID returned from Facebook");
    }
    
    return res.data.id;
  } catch (err) {
    console.error(`FB upload error for ${teamName}:`, err.message);
    throw err;
  }
}

// Fetch fresh Facebook image URL
async function getFbImageUrl(postId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/${postId}?fields=images&access_token=${FB_TOKEN}`,
      { timeout: 5000 }
    );
    
    if (res.data?.images?.[0]?.source) {
      return res.data.images[0].source;
    }
    return null;
  } catch (err) {
    console.error("FB get image error:", err.message);
    return null;
  }
}

// Fetch matches from API
async function fetchMatches() {
  try {
    const res = await axios.get(MATCHES_API, { timeout: 10000 });
    return res.data?.data || [];
  } catch (err) {
    console.error("Failed to fetch matches:", err.message);
    await sendTelegramMessage(`❌ Failed to fetch matches: ${err.message}`);
    return [];
  }
}

// ===================== MAIN PROCESS =====================
async function processMatches() {
  console.log(`=== Starting match processing at ${new Date().toISOString()} ===`);
  
  const teamsLogs = loadTeamsLogs();
  const matches = await fetchMatches();
  
  if (matches.length === 0) {
    console.log("No matches found, skipping...");
    return;
  }

  const uploadResults = { success: [], failed: [] };
  const allProcessedMatches = [];
  const activeTeams = new Set();

  // Process each match
  for (const match of matches) {
    const processedMatch = { ...match };
    const teamsToProcess = [processedMatch.team1, processedMatch.team2];

    for (const team of teamsToProcess) {
      if (!team.name || !team.logo) continue;

      const normalizedLogo = normalizeUrl(team.logo);
      activeTeams.add(team.name);
      
      const existingIndex = teamsLogs.findIndex(t => t.team === team.name);
      let fbImageUrl = null;
      
      if (existingIndex !== -1) {
        // Existing team - get fresh Facebook URL
        const fbPostId = teamsLogs[existingIndex].fb_post_id;
        fbImageUrl = await getFbImageUrl(fbPostId);
        
        if (!fbImageUrl) {
          // Facebook URL failed, try to re-upload
          console.log(`Re-uploading logo for ${team.name}...`);
          try {
            const newPostId = await uploadLogoToFb(team.logo, team.name);
            if (newPostId) {
              teamsLogs[existingIndex].fb_post_id = newPostId;
              teamsLogs[existingIndex].last_updated = new Date().toISOString();
              fbImageUrl = await getFbImageUrl(newPostId);
              uploadResults.success.push(`${team.name} (re-uploaded)`);
            }
          } catch (err) {
            uploadResults.failed.push({ team: team.name, error: err.message });
          }
        }
      } else {
        // New team - upload to Facebook
        try {
          const fbPostId = await uploadLogoToFb(team.logo, team.name);
          if (fbPostId) {
            teamsLogs.push({
              team: team.name,
              fb_post_id: fbPostId,
              last_updated: new Date().toISOString()
            });
            
            fbImageUrl = await getFbImageUrl(fbPostId);
            uploadResults.success.push(team.name);
          }
        } catch (err) {
          uploadResults.failed.push({ team: team.name, error: err.message });
        }
      }
      
      // Replace original logo with Facebook URL
      team.logo = fbImageUrl;
    }
    
    allProcessedMatches.push(processedMatch);
  }

  // Cleanup old entries
  const cleanedLogs = teamsLogs.filter(log => activeTeams.has(log.team));
  saveTeamsLogs(cleanedLogs);

  // ===================== UPDATE FACEBOOK POST USING FETCH =====================
  try {
    // Build the form data
    const formData = new URLSearchParams();
    formData.append('message', JSON.stringify(
      {
        success: true,
        count: allProcessedMatches.length,
        data: allProcessedMatches,
        timestamp: new Date().toISOString(),
        logo_status: {
          facebook_urls: allProcessedMatches.reduce((count, match) => 
            count + (match.team1.logo ? 1 : 0) + (match.team2.logo ? 1 : 0), 0),
          total_teams: allProcessedMatches.length * 2,
          new_uploads: uploadResults.success.length,
          failed_uploads: uploadResults.failed.length
        }
      },
      null,
      2
    ));
    formData.append('access_token', FB_TOKEN);

    // Use fetch to edit the Facebook post
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${MAIN_FB_POST_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
        timeout: 10000,
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Facebook API error: ${JSON.stringify(errorData)}`);
    }

    const result = await response.json();
    console.log("Facebook post updated successfully:", result.id);
  } catch (err) {
    console.error("Failed to update Facebook post using fetch:", err.message);
    
    // Log full error for debugging
    if (err.response) {
      console.error("Error response:", err.response.data);
    }
  }

  // Send single Telegram message
  const teamsWithFbLogo = allProcessedMatches.reduce((count, match) => 
    count + (match.team1.logo ? 1 : 0) + (match.team2.logo ? 1 : 0), 0);
  
  let telegramMessage = `🔄 <b>Match Processing Complete</b>\n`;
  telegramMessage += `⏰ ${new Date().toLocaleTimeString()}\n\n`;
  telegramMessage += `📊 <b>Results:</b>\n`;
  telegramMessage += `• Matches: ${allProcessedMatches.length}\n`;
  telegramMessage += `• Facebook logos: ${teamsWithFbLogo}/${allProcessedMatches.length * 2}\n`;
  
  if (uploadResults.success.length > 0) {
    telegramMessage += `• New uploads: ${uploadResults.success.length}\n`;
  }
  
  if (uploadResults.failed.length > 0) {
    telegramMessage += `• Failed: ${uploadResults.failed.length}\n`;
  }
  
  await sendTelegramMessage(telegramMessage);
  console.log(`Processing complete. Sent Telegram update.`);
}

// ===================== STARTUP =====================
// Verify dependencies are installed
function checkDependencies() {
  try {
    require('axios');
    console.log("✅ All dependencies are available");
    return true;
  } catch (err) {
    console.error("❌ Missing dependencies. Please run:");
    console.error("npm install axios");
    return false;
  }
}

// Initialize and start the process
async function initialize() {
  if (!checkDependencies()) {
    process.exit(1);
  }
  
  console.log("Starting match processing bot...");
  console.log("Configuration:");
  console.log(`- Facebook Post ID: ${MAIN_FB_POST_ID}`);
  console.log(`- Facebook Token: ${FB_TOKEN.substring(0, 15)}...`);
  console.log(`- Telegram Bot: ${TELEGRAM_CONFIG.botToken.substring(0, 15)}...`);
  console.log(`- Telegram Chat: ${TELEGRAM_CONFIG.chatId}`);
  console.log(`- Fetch Interval: ${FETCH_INTERVAL_MIN} minutes`);
  
  // Run immediately
  await processMatches();
  
  // Schedule recurring runs
  setInterval(processMatches, FETCH_INTERVAL_MIN * 60 * 1000);
  console.log(`Scheduled to run every ${FETCH_INTERVAL_MIN} minutes`);
}

// Start the application
initialize().catch(err => {
  console.error("Failed to initialize:", err);
  process.exit(1);
});
