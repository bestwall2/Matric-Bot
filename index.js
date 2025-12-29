const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { URL } = require("url");

// ===================== CONFIG =====================
const MATCHES_API = "https://matric-api.vercel.app/api/today-matches";
const MAIN_FB_POST_ID = "100985439354836_841729738620283";
const FB_TOKEN = "EAAKXMxkBFCIBQSVAYFyTAIQgnukpnQdy5PwiKg5ze4SO3P1sfxM48BnPOZBZAdLHxnCqdnlDaldHXU0AWhFJQ4rAGFHB4uK4yZC8kHr9f6wzHCgGZAGzBDQaAfmAuMZBL715utLfQNRP9D6L5pNcQxOx8905DbT5ZCEzzE9SVyuNkZBmJsOhKvSSfhx5MVCzmHLKboZD";
const TEAMS_LOGS_FILE = path.join(__dirname, "teams_logs.json");
const TELEGRAM_CONFIG = {
  botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
  chatId: "-1002181683719",
};
const FETCH_INTERVAL_MIN = 60;
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

function normalizeUrl(url) {
  if (!url) return "";
  try {
    const urlObj = new URL(url.trim());
    return urlObj.toString().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

async function validateImageUrl(url) {
  try {
    const response = await axios.head(url, { timeout: 5000 });
    const contentType = response.headers['content-type'];
    return contentType && contentType.startsWith('image/');
  } catch {
    return false;
  }
}

async function uploadLogoToFb(imageUrl, teamName) {
  try {
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

// Convert API data directly to your new format
function convertToNewFormat(apiData) {
  return apiData.map(match => ({
    name1: match.team1.name,
    name2: match.team2.name,
    img1: match.team1.logo,
    img2: match.team2.logo,
    time: match.time,
    status: match.status,
    channel: match.channel,
    mic: match.commentator || "غير معروف",
    dawri: match.league,
    result: match.result,
    servers: "[]"
  }));
}

async function fetchMatches() {
  try {
    const res = await axios.get(MATCHES_API, { timeout: 10000 });
    const apiData = res.data?.data || [];
    
    // Convert directly to your new format
    return convertToNewFormat(apiData);
    
  } catch (err) {
    console.error("Failed to fetch matches:", err.message);
    await sendTelegramMessage(`❌ Failed to fetch matches: ${err.message}`);
    return [];
  }
}

// Format for Telegram message
function formatTelegramMessage(matches, uploadResults, teamsWithFbLogo) {
  let message = `🔄 <b>Match Processing Complete</b>\n`;
  message += `⏰ ${new Date().toLocaleTimeString()}\n\n`;
  message += `📊 <b>Results:</b>\n`;
  message += `• Matches: ${matches.length}\n`;
  message += `• Facebook logos: ${teamsWithFbLogo}/${matches.length * 2}\n`;
  
  if (uploadResults.success.length > 0) {
    message += `• New uploads: ${uploadResults.success.length}\n`;
  }
  
  if (uploadResults.failed.length > 0) {
    message += `• Failed: ${uploadResults.failed.length}\n`;
  }
  
  // Add match list
  message += `\n<b>Today's Matches:</b>\n`;
  matches.forEach((match, index) => {
    const fbLogo1 = match.img1 ? '✅' : '❌';
    const fbLogo2 = match.img2 ? '✅' : '❌';
    message += `${index + 1}. ${match.name1} 🆚 ${match.name2}\n`;
    message += `   ${match.time} | ${match.dawri}\n`;
    message += `   Logos: ${fbLogo1} ${fbLogo2}\n\n`;
  });
  
  return message;
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

  // Process each match using new field names
  for (const match of matches) {
    const processedMatch = { ...match };
    
    // Process both teams
    const teamsToProcess = [
      { name: match.name1, logo: match.img1, field: 'img1' },
      { name: match.name2, logo: match.img2, field: 'img2' }
    ];

    for (const team of teamsToProcess) {
      if (!team.name || !team.logo) continue;

      const normalizedLogo = normalizeUrl(team.logo);
      activeTeams.add(team.name);
      
      const existingIndex = teamsLogs.findIndex(t => t.team === team.name);
      let fbImageUrl = null;
      
      if (existingIndex !== -1) {
        const fbPostId = teamsLogs[existingIndex].fb_post_id;
        fbImageUrl = await getFbImageUrl(fbPostId);
        
        if (!fbImageUrl) {
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
      
      // Update the logo in the match object
      processedMatch[team.field] = fbImageUrl;
    }
    
    allProcessedMatches.push(processedMatch);
  }

  // Cleanup old entries
  const cleanedLogs = teamsLogs.filter(log => activeTeams.has(log.team));
  saveTeamsLogs(cleanedLogs);

  // ===================== UPDATE FACEBOOK POST =====================
  try {
    // Prepare final data in your format
    const finalData = {
      success: true,
      count: allProcessedMatches.length,
      data: allProcessedMatches, // Your exact format
      timestamp: new Date().toISOString(),
      logo_status: {
        facebook_urls: allProcessedMatches.reduce((count, match) => 
          count + (match.img1 ? 1 : 0) + (match.img2 ? 1 : 0), 0),
        total_teams: allProcessedMatches.length * 2,
        new_uploads: uploadResults.success.length,
        failed_uploads: uploadResults.failed.length
      },
      processing_info: {
        last_updated: new Date().toISOString(),
        next_update: new Date(Date.now() + FETCH_INTERVAL_MIN * 60 * 1000).toISOString(),
        format: "new_format_v1"
      }
    };
    let MyDATA = allProcessedMatches;
    const formData = new URLSearchParams();
    formData.append('message', JSON.stringify(MyDATA, null, 2));
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
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Facebook API error: ${JSON.stringify(errorData)}`);
    }

    const result = await response.json();
    console.log("✅ Facebook post updated successfully with new format");
    
    // Save the final data to a local file as backup
    const backupFile = path.join(__dirname, `matches_backup_${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(finalData, null, 2));
    console.log(`✅ Backup saved to: ${backupFile}`);
    
  } catch (err) {
    console.error("❌ Failed to update Facebook post:", err.message);
    
    // Save data locally even if Facebook fails
    const localFile = path.join(__dirname, `matches_local_${Date.now()}.json`);
    const localData = {
      success: true,
      count: allProcessedMatches.length,
      data: allProcessedMatches,
      timestamp: new Date().toISOString(),
      error: err.message
    };
    fs.writeFileSync(localFile, JSON.stringify(localData, null, 2));
    console.log(`✅ Data saved locally to: ${localFile}`);
  }

  // Send Telegram message
  const teamsWithFbLogo = allProcessedMatches.reduce((count, match) => 
    count + (match.img1 ? 1 : 0) + (match.img2 ? 1 : 0), 0);
  
  const telegramMessage = formatTelegramMessage(allProcessedMatches, uploadResults, teamsWithFbLogo);
  await sendTelegramMessage(telegramMessage);
  
  console.log(`✅ Processing complete. Sent Telegram update.`);
  console.log(`📊 Final data format used for Facebook post:`);
  console.log(JSON.stringify(allProcessedMatches[0], null, 2));
}

// ===================== STARTUP =====================
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
  console.log(`\n📝 Data Format: Using new format for Facebook post`);
  
  // Run immediately
  await processMatches();
  
  // Schedule recurring runs
  setInterval(processMatches, FETCH_INTERVAL_MIN * 60 * 1000);
  console.log(`\n✅ Bot started. Scheduled to run every ${FETCH_INTERVAL_MIN} minutes`);
}

// Start the application
initialize().catch(err => {
  console.error("Failed to initialize:", err);
  process.exit(1);
});