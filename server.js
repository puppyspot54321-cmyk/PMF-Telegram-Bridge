import express from "express";
import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";

const app = express();
const PORT = process.env.PORT || 3000;

const PMF_MEDIA_CHAT_ID = "4490224317";

let telegramStatus = "starting";
let telegramError = null;
let telegramBot = null;
let lastChat = null;
let lastMediaMessage = null;

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const botToken = process.env.TELEGRAM_BOT_TOKEN;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const client = new TelegramClient(
  new StringSession(""),
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

function getFileReference(mediaObject) {
  if (!mediaObject?.fileReference) {
    return null;
  }

  try {
    return Buffer.from(
      mediaObject.fileReference
    ).toString("base64");
  } catch {
    return null;
  }
}

function describeMedia(message) {
  if (!message?.media) return null;

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
      mimeType:
        document.mimeType ||
        "application/octet-stream",

      size: document.size
        ? String(document.size)
        : null,

      documentId: document.id
        ? String(document.id)
        : null,

      accessHash: document.accessHash
        ? String(document.accessHash)
        : null,

      fileReference:
        getFileReference(document)
    };
  }

  if (message.video) {
    return {
      type: "video",

      mimeType:
        message.video.mimeType ||
        "video/mp4",

      size: message.video.size
        ? String(message.video.size)
        : null,

      videoId: message.video.id
        ? String(message.video.id)
        : null,

      accessHash: message.video.accessHash
        ? String(message.video.accessHash)
        : null,

      fileReference:
        getFileReference(message.video)
    };
  }

  return {
    type: "other",
    mediaClass:
      message.media.className || null
  };
}

async function persistTelegramMedia({
  chatId,
  message,
  media
}) {
  if (
    !supabaseUrl ||
    !supabaseServiceRoleKey
  ) {
    console.warn(
      "Supabase persistence skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing."
    );

    return;
  }

  const payload = {
    chat_id: String(chatId),

    message_id: Number(message.id),

    document_id:
      media.documentId ||
      media.videoId ||
      null,

    access_hash:
      media.accessHash || null,

    file_name:
      media.fileName || null,

    mime_type:
      media.mimeType || null,

    file_size:
      media.size
        ? Number(media.size)
        : null,

    media_kind:
      media.type || null,

    file_reference:
      media.fileReference || null,

    updated_at:
      new Date().toISOString()
  };

  const response = await fetch(
    `${supabaseUrl}/rest/v1/telegram_media_refs`,
    {
      method: "POST",

      headers: {
        apikey:
          supabaseServiceRoleKey,

        Authorization:
          `Bearer ${supabaseServiceRoleKey}`,

        "Content-Type":
          "application/json",

        Prefer:
          "resolution=merge-duplicates,return=minimal"
      },

      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Supabase media reference save failed (${response.status}): ${errorText}`
    );
  }

  console.log(
    "Telegram media reference persisted to Supabase:"
  );

  console.log(
    JSON.stringify({
      chatId,
      messageId: message.id,
      documentId:
        payload.document_id,
      fileSize:
        payload.file_size
    })
  );
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

    telegramBot =
      await client.getMe();

    telegramStatus = "ready";

    console.log(
      `Telegram connected as @${
        telegramBot.username ||
        "unknown"
      }`
    );

    client.addEventHandler(
      async (event) => {
        try {
          const message =
            event.message;

          if (!message) return;

          const chat =
            await message.getChat();

          if (!chat) return;

          const chatId = chat.id
            ? String(chat.id)
            : null;

          const title =
            chat.title || null;

          const username =
            chat.username || null;

          lastChat = {
            id: chatId,
            title,
            username,
            messageId:
              message.id
          };

          console.log(
            "Telegram message received:"
          );

          console.log(
            JSON.stringify(lastChat)
          );

          if (
            chatId !==
            PMF_MEDIA_CHAT_ID
          ) {
            return;
          }

          const media =
            describeMedia(message);

          if (!media) {
            console.log(
              "PMF Media Vault message has no supported media."
            );

            return;
          }

          lastMediaMessage =
            message;

          console.log(
            "PMF Media Vault media captured:"
          );

          console.log(
            JSON.stringify({
              chatId,
              messageId:
                message.id,
              media
            })
          );

          try {
            await persistTelegramMedia({
              chatId,
              message,
              media
            });
          } catch (error) {
            console.error(
              "Failed to persist Telegram media reference:",
              error
            );
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

    telegramError =
      error.message;

    console.error(
      "Telegram connection failed:",
      error
    );
  }
}

app.get("/", (_req, res) => {
  res.json({
    name:
      "PMF Telegram Bridge",

    status: "online",

    version: "2.2.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

app.get(
  "/telegram-status",
  (_req, res) => {
    res.json({
      status:
        telegramStatus,

      connected:
        telegramStatus ===
        "ready",

      bot: telegramBot
        ? {
            id:
              String(
                telegramBot.id
              ),

            username:
              telegramBot.username ||
              null,

            isBot:
              telegramBot.bot ===
              true
          }
        : null,

      error:
        telegramError
    });
  }
);

app.get(
  "/telegram-last-chat",
  (_req, res) => {
    res.json({
      chat: lastChat
    });
  }
);

app.get(
  "/telegram-latest-media",
  async (_req, res) => {
    try {
      if (
        telegramStatus !==
        "ready"
      ) {
        return res
          .status(503)
          .json({
            found: false,

            error:
              "Telegram client is not ready",

            status:
              telegramStatus
          });
      }

      if (!lastMediaMessage) {
        return res
          .status(404)
          .json({
            found: false,

            error:
              "No media has been captured yet. Send a new media message in PMF Media Vault."
          });
      }

      const media =
        describeMedia(
          lastMediaMessage
        );

      return res.json({
        found:
          Boolean(media),

        chat: {
          id:
            PMF_MEDIA_CHAT_ID,

          title:
            "PMF Media Vault"
        },

        message: {
          id:
            lastMediaMessage.id,

          date:
            lastMediaMessage.date
              ? new Date(
                  lastMediaMessage.date *
                    1000
                ).toISOString()
              : null,

          text:
            lastMediaMessage.message ||
            null
        },

        media
      });
    } catch (error) {
      console.error(
        "Latest captured media lookup failed:",
        error
      );

      return res
        .status(500)
        .json({
          found: false,
          error:
            error.message
        });
    }
  }
);

app.get(
  "/telegram-media",
  async (req, res) => {
    try {
      if (
        telegramStatus !==
        "ready"
      ) {
        return res
          .status(503)
          .json({
            error:
              "Telegram client is not ready",

            status:
              telegramStatus
          });
      }

      if (
        !lastMediaMessage?.media
      ) {
        return res
          .status(404)
          .json({
            error:
              "No media has been captured yet. Send a new media message in PMF Media Vault."
          });
      }

      const media =
        describeMedia(
          lastMediaMessage
        );

      const totalSize =
        Number(
          media?.size || 0
        );

      if (
        !Number.isSafeInteger(
          totalSize
        ) ||
        totalSize <= 0
      ) {
        return res
          .status(500)
          .json({
            error:
              "Captured media does not contain a valid file size."
          });
      }

      let startByte = 0;
      let endByte =
        totalSize - 1;

      let partial = false;

      const rangeHeader =
        req.headers.range;

      if (rangeHeader) {
        const match =
          /^bytes=(\d*)-(\d*)$/.exec(
            rangeHeader.trim()
          );

        if (
          !match ||
          (match[1] === "" &&
            match[2] === "")
        ) {
          return res
            .status(416)
            .set(
              "Content-Range",
              "bytes */" +
                totalSize
            )
            .end();
        }

        if (match[1] === "") {
          const suffixLength =
            Number(match[2]);

          if (
            !Number.isSafeInteger(
              suffixLength
            ) ||
            suffixLength <= 0
          ) {
            return res
              .status(416)
              .set(
                "Content-Range",
                "bytes */" +
                  totalSize
              )
              .end();
          }

          startByte =
            Math.max(
              totalSize -
                suffixLength,
              0
            );
        } else {
          startByte =
            Number(match[1]);

          if (
            !Number.isSafeInteger(
              startByte
            ) ||
            startByte >=
              totalSize
          ) {
            return res
              .status(416)
              .set(
                "Content-Range",
                "bytes */" +
                  totalSize
              )
              .end();
          }

          if (
            match[2] !== ""
          ) {
            endByte =
              Number(match[2]);

            if (
              !Number.isSafeInteger(
                endByte
              ) ||
              endByte <
                startByte
            ) {
              return res
                .status(416)
                .set(
                  "Content-Range",
                  "bytes */" +
                    totalSize
                )
                .end();
            }
          }
        }

        endByte =
          Math.min(
            endByte,
            totalSize - 1
          );

        partial = true;
      }

      const contentLength =
        endByte -
        startByte +
        1;

      res.status(
        partial ? 206 : 200
      );

      res.set({
        "Content-Type":
          media?.mimeType ||
          "video/mp4",

        "Content-Length":
          String(
            contentLength
          ),

        "Accept-Ranges":
          "bytes",

        "Cache-Control":
          "no-store"
      });

      if (partial) {
        res.set(
          "Content-Range",
          "bytes " +
            startByte +
            "-" +
            endByte +
            "/" +
            totalSize
        );
      }

      if (media?.fileName) {
        res.set(
          "Content-Disposition",
          "inline; filename*=UTF-8''" +
            encodeURIComponent(
              media.fileName
            )
        );
      }

      const telegramOffset =
        bigInt(startByte);

      const iterator =
        client.iterDownload({
          file:
            lastMediaMessage.media,

          offset:
            telegramOffset,

          limit:
            contentLength,

          chunkSize:
            4 * 1024 * 1024,

          requestSize:
            4 * 1024 * 1024
        });

      for await (
        const chunk of iterator
      ) {
        if (res.destroyed)
          break;

        if (
          !res.write(chunk)
        ) {
          await new Promise(
            (resolve) =>
              res.once(
                "drain",
                resolve
              )
          );
        }
      }

      if (!res.destroyed) {
        res.end();
      }
    } catch (error) {
      console.error(
        "Telegram media streaming failed:",
        error
      );

      if (!res.headersSent) {
        return res
          .status(500)
          .json({
            error:
              error.message
          });
      }

      res.destroy(error);
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `PMF Telegram Bridge listening on port ${PORT}`
  );

  void connectTelegram();
});
