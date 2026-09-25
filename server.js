import express from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";

const app = express();
const PORT = process.env.PORT || 3000;

let telegramStatus = "starting";
let telegramError = null;
let telegramBot = null;

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
  } catch (error) {
    telegramStatus = "error";
    telegramError = error.message;

    console.error("Telegram connection failed:", error);
  }
}

app.get("/", (_req, res) => {
  res.json({
    name: "PMF Telegram Bridge",
    status: "online",
    version: "1.2.0"
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
          username: telegramBot.username || null,
          isBot: telegramBot.bot === true
        }
      : null,
    error: telegramError
  });
});

app.get("/telegram-chats", async (_req, res) => {
  try {
    if (telegramStatus !== "ready") {
      return res.status(503).json({
        error: "Telegram is not connected yet"
      });
    }

    const dialogs = await client.getDialogs({
      limit: 100
    });

    const chats = dialogs.map((dialog) => {
      const entity = dialog.entity;

      return {
        id: entity?.id ? String(entity.id) : null,
        title: entity?.title || null,
        username: entity?.username || null,
        isGroup: Boolean(
          entity?.className === "Chat" ||
          entity?.className === "Channel"
        )
      };
    });

    res.json({
      count: chats.length,
      chats
    });
  } catch (error) {
    console.error("Telegram chats error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`PMF Telegram Bridge listening on port ${PORT}`);

  void connectTelegram();
});
