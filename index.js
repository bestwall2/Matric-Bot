const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ===================== CONFIG =====================
const MATCHES_API = "https://matric-api.vercel.app/api/today-matches";
const MAIN_FB_POST_ID = "100985439354836_841729738620283";
const FB_TOKEN =
  "EAFb7enAJEpABQU1a6tskVcb9q2v6wZCh9RU3ZBZAavjoYHObyq462oKiREZBxZBOS88KNh3apkZCB36TTodMOwkDSpJxBdHXViAZBXn0CMBKuYI4rEAk2ZCRGJ9pnQAJgaM31w6rW6m4lLP9OxMZCZBe3jv72nc2URB2xGshv2BheZCcrApMJ1HDC52pzA1UYogZAsGUzZAiY9grZB";
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

// Remove spaces, lowercase to normalize URLs for comparison
function normalizeUrl(url) {
  if (!url) return "";
  return url.trim();
}

// Fetch Facebook image URL for a given post ID
async function getFbImageUrl(postId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v17.0/${postId}/attachments?fields=media&access_token=${FB_TOKEN}`
    );
    if (res.data?.data?.[0]?.media?.image?.src) return res.data.data[0].media.image.src;
  } catch (err) {
    console.error("FB get image error:", err.message);
  }
  return null;
}

// Upload image to Facebook (logo) and return post ID
async function uploadLogoToFb(imageUrl, teamName) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v17.0/me/photos`,
      null,
      {
        params: {
          url: imageUrl,
          caption: `Logo of ${teamName}`,
          access_token: FB_TOKEN,
        },
      }
    );
    return res.data?.id || null;
  } catch (err) {
    console.error(`FB upload error for ${teamName}:`, err.message);
    await sendTelegramMessage(`❌ Failed to upload logo for <b>${teamName}</b>\n${err.message}`);
    return null;
  }
}

// Fetch matches JSON from Matric API
async function fetchMatches() {
  try {
    const res = await axios.get(MATCHES_API);
    return res.data?.data || [];
  } catch (err) {
    console.error("Failed to fetch matches:", err.message);
    return [];
  }
}

// Format matches to send as nice message to Telegram
function formatTelegramMessage(matches) {
  let msg = `⚽ <b>Today's Matches</b> ⚽\n\n`;
  matches.forEach((m) => {
    msg += `🏟 <b>${m.league}</b>\n`;
    msg += `🔹 ${m.team1.name} vs ${m.team2.name}\n`;
    msg += `🕒 ${m.time} | 📺 ${m.channel}\n`;
    msg += `🔹 Status: ${m.status} | Result: ${m.result}\n\n`;
  });
  return msg;
}

// ===================== MAIN LOOP =====================
async function processMatches() {
  const teamsLogs = loadTeamsLogs();
  const matches = await fetchMatches();

  for (const match of matches) {
    for (const team of [match.team1, match.team2]) {
      if (!team.name || !team.logo) continue;

      const normalizedLogo = normalizeUrl(team.logo);
      const existing = teamsLogs.find((t) => t.team === team.name);

      if (existing) {
        // Team exists, fetch fresh FB URL
        const fbUrl = await getFbImageUrl(existing.fb_post_id);
        if (fbUrl) team.logo = fbUrl;
      } else {
        // Upload new logo to FB
        const fbPostId = await uploadLogoToFb(team.logo, team.name);
        if (fbPostId) {
          teamsLogs.push({
            team: team.name,
            fb_post_id: fbPostId,
          });
          // Get the fresh URL
          const fbUrl = await getFbImageUrl(fbPostId);
          if (fbUrl) team.logo = fbUrl;

          await sendTelegramMessage(`✅ Logo uploaded for <b>${team.name}</b>`);
        }
      }
    }
  }

  saveTeamsLogs(teamsLogs);

  // Edit main FB post with JSON
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${MAIN_FB_POST_ID}`,
      null,
      {
        params: {
          message: JSON.stringify({ success: true, count: matches.length, data: matches }, null, 2),
          access_token: FB_TOKEN,
        },
      }
    );
    await sendTelegramMessage(`📢 Main Facebook post updated with ${matches.length} matches`);
  } catch (err) {
    console.error("Failed to edit main FB post:", err.message);
    await sendTelegramMessage(`❌ Failed to update main FB post: ${err.message}`);
  }

  // Send beautiful message to Telegram
  const telegramMessage = formatTelegramMessage(matches);
  await sendTelegramMessage(telegramMessage);
}

// ===================== KEEP ALIVE =====================
processMatches(); // run immediately
setInterval(processMatches, FETCH_INTERVAL_MIN * 60 * 1000); // repeat every 60 minutes
