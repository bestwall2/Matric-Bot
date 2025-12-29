// ===================== CONFIG =====================
const MATCHES_API = "https://matric-api.vercel.app/api/today-matches";
const MAIN_FB_POST_ID = "100985439354836_841729738620283";  // <-- Facebook Post ID here
const FB_TOKEN = "EAFb7enAJEpABQU1a6tskVcb9q2v6wZCh9RU3ZBZAavjoYHObyq462oKiREZBxZBOS88KNh3apkZCB36TTodMOwkDSpJxBdHXViAZBXn0CMBKuYI4rEAk2ZCRGJ9pnQAJgaM31w6rW6m4lLP9OxMZCZBe3jv72nc2URB2xGshv2BheZCcrApMJ1HDC52pzA1UYogZAsGUzZAiY9grZB";  // <-- Facebook Token here
const TEAMS_LOGS_FILE = path.join(__dirname, "teams_logs.json");
const TELEGRAM_CONFIG = {
  botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
  chatId: "-1002181683719",
};
const FETCH_INTERVAL_MIN = 60; // minutes
// ===================================================

// ===================== UPDATED CODE =====================

// Remove spaces, lowercase to normalize URLs for comparison - ENHANCED
function normalizeUrl(url) {
  if (!url) return "";
  // Remove query parameters and fragments, keep only clean URL
  return url.trim().toLowerCase().split('?')[0].split('#')[0];
}

// Upload image to Facebook (logo) and return post ID
async function uploadLogoToFb(imageUrl, teamName) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/me/photos`,
      null,
      {
        params: {
          url: imageUrl,
          published: false,
          access_token: FB_TOKEN,
        },
      }
    );
    return res.data?.id || null;
  } catch (err) {
    console.error(`FB upload error for ${teamName}:`, err.message);
    throw new Error(`Failed to upload logo for ${teamName}: ${err.message}`);
  }
}

// Fetch fresh Facebook image URL for a given post ID
async function getFbImageUrl(postId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/${postId}?fields=images&access_token=${FB_TOKEN}`
    );
    // Get the first (usually largest) image URL
    if (res.data?.images?.[0]?.source) {
      return res.data.images[0].source;
    }
  } catch (err) {
    console.error("FB get image error for post", postId, ":", err.message);
  }
  return null;
}

// ===================== MAIN LOOP - REVISED =====================
async function processMatches() {
  const teamsLogs = loadTeamsLogs();
  const matches = await fetchMatches();

  // Track results
  const uploadResults = {
    success: [],
    failed: []
  };
  const allProcessedMatches = [];
  
  // To cleanup old entries
  const activeTeams = new Set();

  // Process each match
  for (const match of matches) {
    const processedMatch = { ...match };
    const teamsToProcess = [processedMatch.team1, processedMatch.team2];

    // Process each team in the match
    for (const team of teamsToProcess) {
      if (!team.name || !team.logo) continue;

      const normalizedLogo = normalizeUrl(team.logo);
      activeTeams.add(team.name);
      
      // Find existing entry for this team
      const existingIndex = teamsLogs.findIndex(t => t.team === team.name);
      
      let fbPostId = null;
      let fbImageUrl = null;
      
      if (existingIndex !== -1) {
        // Team exists - use existing FB post ID
        fbPostId = teamsLogs[existingIndex].fb_post_id;
        
        // Get fresh Facebook URL (every 60 minutes as requested)
        fbImageUrl = await getFbImageUrl(fbPostId);
        
        if (!fbImageUrl) {
          // Facebook URL failed, try to re-upload
          console.log(`Facebook URL not available for ${team.name}, re-uploading...`);
          try {
            fbPostId = await uploadLogoToFb(team.logo, team.name);
            if (fbPostId) {
              teamsLogs[existingIndex].fb_post_id = fbPostId;
              teamsLogs[existingIndex].last_updated = new Date().toISOString();
              fbImageUrl = await getFbImageUrl(fbPostId);
              uploadResults.success.push(team.name + " (re-uploaded)");
            }
          } catch (err) {
            uploadResults.failed.push({
              team: team.name,
              error: err.message
            });
          }
        }
      } else {
        // New team - upload to Facebook
        try {
          fbPostId = await uploadLogoToFb(team.logo, team.name);
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
          uploadResults.failed.push({
            team: team.name,
            error: err.message
          });
        }
      }
      
      // REPLACE original logo with Facebook URL (or null if failed)
      team.logo = fbImageUrl; // Direct replacement
      
      // Remove original logo property since we don't need it
      delete team.originalLogo;
    }
    
    allProcessedMatches.push(processedMatch);
  }

  // Cleanup: Remove teams that are no longer in current matches
  const cleanedLogs = teamsLogs.filter(log => activeTeams.has(log.team));
  
  // Save cleaned logs (no original URLs stored)
  saveTeamsLogs(cleanedLogs);

  // 1. Edit main FB post with JSON (only Facebook URLs)
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${MAIN_FB_POST_ID}`,
      null,
      {
        params: {
          message: JSON.stringify(
            {
              success: true,
              count: allProcessedMatches.length,
              data: allProcessedMatches,
              timestamp: new Date().toISOString(),
              logo_status: {
                facebook_urls: allProcessedMatches.reduce((count, match) => {
                  return count + 
                    (match.team1.logo ? 1 : 0) + 
                    (match.team2.logo ? 1 : 0);
                }, 0),
                total_teams: allProcessedMatches.length * 2,
                new_uploads: uploadResults.success.length,
                failed_uploads: uploadResults.failed.length
              }
            },
            null,
            2
          ),
          access_token: FB_TOKEN,
        },
      }
    );
  } catch (err) {
    console.error("Failed to edit main FB post:", err.message);
  }

  // 2. Send SINGLE Telegram message
  let telegramMessage = `🔄 <b>Matches Processing Complete</b>\n`;
  telegramMessage += `⏰ ${new Date().toLocaleTimeString()}\n\n`;
  
  telegramMessage += `📊 <b>Logo Status:</b>\n`;
  const totalTeams = allProcessedMatches.length * 2;
  const teamsWithFbLogo = allProcessedMatches.reduce((count, match) => {
    return count + 
      (match.team1.logo ? 1 : 0) + 
      (match.team2.logo ? 1 : 0);
  }, 0);
  
  telegramMessage += `✅ Facebook URLs: ${teamsWithFbLogo}/${totalTeams}\n`;
  
  if (uploadResults.success.length > 0) {
    telegramMessage += `📤 New uploads: ${uploadResults.success.length}\n`;
  }
  
  if (uploadResults.failed.length > 0) {
    telegramMessage += `❌ Failed: ${uploadResults.failed.length}\n`;
  }
  
  telegramMessage += `\n📋 <b>Matches:</b> ${allProcessedMatches.length}\n`;

  // Optional: Show matches summary (commented to keep message short)
  
  telegramMessage += `\n<b>Match List:</b>\n`;
  allProcessedMatches.slice(0, 3).forEach((m, index) => {
    telegramMessage += `${index + 1}. ${m.team1.name} vs ${m.team2.name}\n`;
    telegramMessage += `   ${m.time} | ${m.league}\n`;
  });
  
  if (allProcessedMatches.length > 3) {
    telegramMessage += `... and ${allProcessedMatches.length - 3} more matches\n`;
  }
  

  await sendTelegramMessage(telegramMessage);

  console.log(`Processing complete at ${new Date().toISOString()}`);
}

// ===================== KEEP ALIVE =====================
processMatches(); // run immediately
setInterval(processMatches, FETCH_INTERVAL_MIN * 60 * 1000); // repeat every 60 minutes
