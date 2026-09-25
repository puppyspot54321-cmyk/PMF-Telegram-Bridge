import express from "express";
import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";

const app = express();
const PORT = process.env.PORT || 3000;

const PMF_MEDIA_CHAT_ID = "4490224317";

let telegramStatus = "starting";
let telegramError = null;
let telegramBot = null;
let lastChat = null;
let pmfMediaChat = null;

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

function describeMedia(message) {
  if (!message?.media) {
    return null;
  }

  const document = message.document;

  if (document) {
    let fileName = null;

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
      mimeType: document.mimeType || null,
      size: document.size ? String(document.size) : null,
      documentId: document.id
        ? String(document.id)
        : null,
      accessHash: document.accessHash
        ? String(document.accessHash)
        : null
    };
  }

  if (message.video) {
    return {
      type: "video",
      mimeType: message.video.mimeType || "video/mp4",
      size: message.video.size
        ? String(message.video.size)
        : null,
      videoId: message.video.id
        ? String(message.video.id)
        : null,
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
      throw new Error(
        "Telegram environment variables are missing"
      );
    }

    console.log(
      "Connecting PMF Telegram Bridge to Telegram..."
    );

    await client.start({
      botAuthToken: botToken,
      onError: (error) => {
        console.error(
          "Telegram client error:",
          error
        );
      }
    });

    telegramBot = await client.getMe();
    telegramStatus = "ready";

    console.log(
      `Telegram connected as @${telegramBot.username || "unknown"}`
    );

    client.addEventHandler(
      async (event) => {
        try {
          const message = event.message;

          if (!message) return;

          const chat = await message.getChat();

          if (!chat) return;

          const chatId = chat.id
            ? String(chat.id)
            : null;

          const title = chat.title || null;
          const username = chat.username || null;

          lastChat = {
            id: chatId,
            title,
            username,
            messageId: message.id
          };

          console.log(
            "Telegram message received:"
          );

          console.log(
            JSON.stringify(lastChat)
          );

          /*
           * IMPORTANT:
           * Keep the actual Telegram entity object.
           * We will reuse this instead of trying to
           * reconstruct the entity from a bare ID.
           */
          if (chatId === PMF_MEDIA_CHAT_ID) {
            pmfMediaChat = chat;

            console.log(
              "PMF Media Vault entity captured."
            );

            const media = describeMedia(message);

            if (media) {
              console.log(
                "PMF Media Vault media detected:"
              );

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

    console.error(
      "Telegram connection failed:",
      error
    );
  }
}

app.get("/", (_req, res) => {
  res.json({
    name: "PMF Telegram Bridge",
    status: "online",
    version: "1.5.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

app.get("/telegram-status", (_req, res) => {
  res.json({
    status: telegramStatus,
    connected: telegramStatus === "ready",
    bot: telegramBot
      ? {
          id: String(telegramBot.id),
          username:
            telegramBot.username || null,
          isBot: telegramBot.bot === true
        }
      : null,
    error: telegramError
  });
});

app.get("/telegram-last-chat", (_req, res) => {
  res.json({
    chat: lastChat
  });
});

app.get(
  "/telegram-latest-media",
  async (_req, res) => {
    try {
      if (telegramStatus !== "ready") {
        return res.status(503).json({
          error:
            "Telegram client is not ready",
          status: telegramStatus
        });
      }

      /*
       * The bridge must first receive a message
       * from PMF Media Vault after startup so that
       * we have the real Telegram entity.
       */
      if (!pmfMediaChat) {
        return res.status(404).json({
          found: false,
          error:
            "PMF Media Vault entity has not been captured yet. Send a new message in the group and try again."
        });
      }

      const messages = await client.getMessages(
        pmfMediaChat,
        {
          limit: 50
        }
      );

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
              ? new Date(
                  message.date * 1000
                ).toISOString()
              : null,
            text: message.message || null
          },
          media
        });
      }

      return res.json({
        found: false,
        message:
          "No supported media message was found in PMF Media Vault."
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
  }
);

app.listen(PORT, () => {
  console.log(
    `PMF Telegram Bridge listening on port ${PORT}`
  );

  void connectTelegram();
});
