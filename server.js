import express from "express";
import { TelegramClient, Api, events } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const app = express();
const PORT = process.env.PORT || 3000;

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

    client.addEventHandler(async (event) => {
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

      } catch (error) {
        console.error("Telegram message inspection error:", error);
      }
    }, new events.NewMessage({}));

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
    version: "1.3.0"
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

app.get("/telegram-last-chat", (_req, res) => {
  res.json({
    chat: lastChat
  });
});

app.listen(PORT, () => {
  console.log(`PMF Telegram Bridge listening on port ${PORT}`);

  void connectTelegram();
});
