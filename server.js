import express from "express";
import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";

const app = express();
const PORT = process.env.PORT || 3000;

/*
 * PMF MEDIA VAULT
 * This is the Telegram group that permanently holds PMF media.
 */
const PMF_MEDIA_CHAT_ID = "4490224317";

let telegramStatus = "starting";
let telegramError = null;
let telegramBot = null;
let lastChat = null;

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const botToken = process.env.TELEGRAM_BOT_TOKEN;

const client = new TelegramClient(
  new StringSession(""),
  apiId,
  apiHash,
  {
    connectionRetries: 5
  }
);

/*
 * Extract useful information from a Telegram message
 * without downloading the media.
 */
function describeMedia(message) {
  if (!message?.media) {
    return null;
  }

  const document = message.document;

  if (document) {
    let fileName = null;
    let mimeType = document.mimeType || null;
    let size = document.size ? String(document.size) : null;

    if (Array.isArray(document.attributes)) {
      for (const attribute of document.attributes) {
        if (
          attribute &&
          typeof attribute.fileName === "string" &&
          attribute.fileName
        ) {
          fileName = attribute.fileName;
        }
      }
    }

    return {
      type: "document",
      fileName,
      mimeType,
      size,
      documentId: document.id ? String(document.id) : null,
      accessHash: document.accessHash
        ? String(document.accessHash)
        : null
    };
  }

  if (message.video) {
    return {
      type: "video",
      mimeType: message.video.mimeType || "video/mp4",
      size: message.video.size ? String(message.video.size) : null,
      videoId: message.video.id ? String(message.video.id) : null,
      accessHash: message.video.accessHash
        ? String(message.video.accessHash)
        : null
    };
  }

  return {
    type: "other",
    mediaClass: message.media.className || null
  };
}

async function connectTelegram() {
  try {
    if (!apiId || !apiHash || !botToken) {
      throw new Error("Telegram environment variables are missing");
    }

    console.log("Connecting PMF Telegram Bridge to Telegram...");

    await client.start({
      botAuthToken: botToken,
      onError: (error) => {
        console.error("Telegram client error:", error);
      }
    });

    telegramBot = await client.getMe();
    telegramStatus = "ready";

    console.log(
      `Telegram connected as @${telegramBot.username || "unknown"}`
    );

    /*
     * Listen for new Telegram messages.
     * This is mainly used to confirm that the bridge can see
     * the PMF Media Vault and its incoming media.
     */
    client.addEventHandler(
      async (event) => {
        try {
          const message = event.message;

          if (!message) return;

          const chat = await message.getChat();

          if (!chat) return;

          const chatId = chat.id ? String(chat.id) : null;
          const title = chat.title || null;
          const username = chat.username || null;

          lastChat = {
            id: chatId,
            title,
            username,
            messageId: message.id
          };

          console.log("Telegram message received:");
          console.log(JSON.stringify(lastChat));

          /*
           * Only inspect media belonging to PMF Media Vault.
           */
          if (chatId === PMF_MEDIA_CHAT_ID) {
            const media = describeMedia(message);

            if (media) {
              console.log("PMF Media Vault media detected:");
              console.log(
                JSON.stringify({
                  chatId,
                  messageId: message.id,
                  media
                })
              );
            }
          }
        } catch (error) {
          console.error(
            "Telegram message inspection error:",
            error
          );
        }
      },
      new NewMessage({})
    );
  } catch (error) {
    telegramStatus = "error";
    telegramError = error.message;

    console.error("Telegram connection failed:", error);
  }
}

/*
 * Root
 */
app.get("/", (_req, res) => {
  res.json({
    name: "PMF Telegram Bridge",
    status: "online",
    version: "1.4.0"
  });
});

/*
 * Health check
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

/*
 * Telegram connection status
 */
app.get("/telegram-status", (_req, res) => {
  res.json({
    status: telegramStatus,
    connected: telegramStatus === "ready",
    bot: telegramBot
      ? {
          id: String(telegramBot.id),
          username: telegramBot.username || null,
          isBot: telegramBot.bot === true
        }
      : null,
    error: telegramError
  });
});

/*
 * Last Telegram chat detected by the bridge.
 */
app.get("/telegram-last-chat", (_req, res) => {
  res.json({
    chat: lastChat
  });
});

/*
 * Find the latest media message inside PMF Media Vault.
 *
 * IMPORTANT:
 * This endpoint only reads Telegram metadata.
 * It does NOT download or store the movie.
 */
app.get("/telegram-latest-media", async (_req, res) => {
  try {
    if (telegramStatus !== "ready") {
      return res.status(503).json({
        error: "Telegram client is not ready",
        status: telegramStatus
      });
    }

    const chat = await client.getEntity(PMF_MEDIA_CHAT_ID);

    const messages = await client.getMessages(chat, {
      limit: 50
    });

    for (const message of messages) {
      const media = describeMedia(message);

      if (!media) continue;

      return res.json({
        found: true,
        chat: {
          id: PMF_MEDIA_CHAT_ID,
          title: "PMF Media Vault"
        },
        message: {
          id: message.id,
          date: message.date
            ? new Date(message.date * 1000).toISOString()
            : null,
          text: message.message || null
        },
        media
      });
    }

    return res.json({
      found: false,
      message: "No supported media message was found in PMF Media Vault."
    });
  } catch (error) {
    console.error(
      "Latest Telegram media lookup failed:",
      error
    );

    return res.status(500).json({
      found: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `PMF Telegram Bridge listening on port ${PORT}`
  );

  void connectTelegram();
});
