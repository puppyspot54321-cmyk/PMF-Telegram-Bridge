import express from "express";
import { TelegramClient, Api } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";

const app = express();
const PORT = process.env.PORT || 3000;

const PMF_MEDIA_CHAT_ID = "4490224317";

const STREAM_BUFFER_SIZE =
  8 * 1024 * 1024;

const STARTUP_BUFFER_SIZE =
  2 * 1024 * 1024;

const STREAM_PREFETCH_TRIGGER =
  1 * 1024 * 1024;

const STREAM_FETCH_CHUNK_SIZE =
  1 * 1024 * 1024;

const STREAM_FETCH_REQUEST_SIZE =
  4 * 1024 * 1024;

const DELIVERY_CHUNK_SIZE =
  256 * 1024;

let telegramStatus = "starting";
let telegramError = null;
let telegramBot = null;
let lastChat = null;
let lastMediaMessage = null;

let currentStreamBuffer = null;
let nextStreamBuffer = null;

let streamBufferPromise = null;
let nextStreamBufferPromise = null;

const apiId =
  Number(process.env.TELEGRAM_API_ID);

const apiHash =
  process.env.TELEGRAM_API_HASH;

const botToken =
  process.env.TELEGRAM_BOT_TOKEN;

const supabaseUrl =
  process.env.SUPABASE_URL;

const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const client =
  new TelegramClient(
    new StringSession(""),
    apiId,
    apiHash,
    {
      connectionRetries: 5
    }
  );

function clearStreamBuffer() {
  currentStreamBuffer = null;
  nextStreamBuffer = null;
  streamBufferPromise = null;
  nextStreamBufferPromise = null;
}

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

function decodeFileReference(value) {
  if (!value) {
    return null;
  }

  try {
    return Buffer.from(
      value,
      "base64"
    );
  } catch {
    return null;
  }
}

async function getMappedTelegramMedia(movieId) {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  const query =
    supabaseUrl +
    "/rest/v1/telegram_media_refs" +
    "?movie_id=eq." + encodeURIComponent(movieId) +
    "&limit=1";

  const response = await fetch(query, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      "Mapped Telegram media lookup failed (" +
      response.status +
      "): " +
      errorText
    );
  }

  const rows = await response.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const row = rows[0];

  if (!row.document_id || !row.access_hash || !row.file_reference) {
    throw new Error(
      "Telegram media mapping is incomplete for movie " +
      movieId +
      "."
    );
  }

  const fileReference = decodeFileReference(row.file_reference);

  if (!fileReference) {
    throw new Error(
      "Telegram file reference could not be decoded for movie " +
      movieId +
      "."
    );
  }

  const inputLocation = new Api.InputDocumentFileLocation({
    id: bigInt(row.document_id),
    accessHash: bigInt(row.access_hash),
    fileReference,
    thumbSize: ""
  });

  const restoredDocument = {
    id: bigInt(row.document_id),
    accessHash: bigInt(row.access_hash),
    fileReference,
    mimeType: row.mime_type || "video/mp4",
    size: row.file_size ? bigInt(row.file_size) : null,
    attributes: []
  };

  return {
    id: Number(row.message_id),
    date: Math.floor(
      new Date(row.updated_at || Date.now()).getTime() / 1000
    ),
    message: null,
    media: inputLocation,
    document: restoredDocument
  };
}

function describeMedia(message) {
  if (!message?.media) {
    return null;
  }

  const document =
    message.document;

  if (document) {
    let fileName = null;

    if (
      Array.isArray(
        document.attributes
      )
    ) {
      for (
        const attribute
        of document.attributes
      ) {
        if (
          attribute &&
          typeof attribute.fileName ===
            "string" &&
          attribute.fileName
        ) {
          fileName =
            attribute.fileName;
        }
      }
    }

    return {
      type: "document",

      fileName,

      mimeType:
        document.mimeType ||
        "application/octet-stream",

      size:
        document.size
          ? String(
              document.size
            )
          : null,

      documentId:
        document.id
          ? String(
              document.id
            )
          : null,

      accessHash:
        document.accessHash
          ? String(
              document.accessHash
            )
          : null,

      fileReference:
        getFileReference(
          document
        )
    };
  }

  if (message.video) {
    return {
      type: "video",

      mimeType:
        message.video.mimeType ||
        "video/mp4",

      size:
        message.video.size
          ? String(
              message.video.size
            )
          : null,

      videoId:
        message.video.id
          ? String(
              message.video.id
            )
          : null,

      accessHash:
        message.video.accessHash
          ? String(
              message.video.accessHash
            )
          : null,

      fileReference:
        getFileReference(
          message.video
        )
    };
  }

  return {
    type: "other",

    mediaClass:
      message.media.className ||
      null
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
      "Supabase persistence skipped: environment variables are missing."
    );

    return;
  }

  const payload = {
    chat_id:
      String(chatId),

    message_id:
      Number(message.id),

    document_id:
      media.documentId ||
      media.videoId ||
      null,

    access_hash:
      media.accessHash ||
      null,

    file_name:
      media.fileName ||
      null,

    mime_type:
      media.mimeType ||
      null,

    file_size:
      media.size
        ? Number(
            media.size
          )
        : null,

    media_kind:
      media.type ||
      null,

    file_reference:
      media.fileReference ||
      null,

    updated_at:
      new Date().toISOString()
  };

  const response =
    await fetch(
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

        body:
          JSON.stringify(
            payload
          )
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

      messageId:
        message.id,

      documentId:
        payload.document_id,

      fileSize:
        payload.file_size
    })
  );
}

async function restoreLatestTelegramMedia() {
  if (
    !supabaseUrl ||
    !supabaseServiceRoleKey
  ) {
    console.warn(
      "Media restore skipped: Supabase environment variables are missing."
    );

    return;
  }

  try {
    const query =
      `${supabaseUrl}/rest/v1/telegram_media_refs` +
      `?chat_id=eq.${encodeURIComponent(
        PMF_MEDIA_CHAT_ID
      )}` +
      `&order=updated_at.desc` +
      `&limit=1`;

    const response =
      await fetch(
        query,
        {
          headers: {
            apikey:
              supabaseServiceRoleKey,

            Authorization:
              `Bearer ${supabaseServiceRoleKey}`
          }
        }
      );

    if (!response.ok) {
      const errorText =
        await response.text();

      throw new Error(
        `Supabase media restore failed (${response.status}): ${errorText}`
      );
    }

    const rows =
      await response.json();

    if (
      !Array.isArray(rows) ||
      rows.length === 0
    ) {
      console.log(
        "No persisted Telegram media reference found."
      );

      return;
    }

    const row = rows[0];

    if (
      !row.document_id ||
      !row.access_hash ||
      !row.file_reference
    ) {
      console.warn(
        "Latest persisted Telegram media reference is incomplete."
      );

      return;
    }

    const fileReference =
      decodeFileReference(
        row.file_reference
      );

    if (!fileReference) {
      console.warn(
        "Could not decode persisted Telegram file reference."
      );

      return;
    }

    const inputLocation =
      new Api.InputDocumentFileLocation({
        id:
          bigInt(
            row.document_id
          ),

        accessHash:
          bigInt(
            row.access_hash
          ),

        fileReference,

        thumbSize: ""
      });

    const restoredDocument = {
      id:
        bigInt(
          row.document_id
        ),

      accessHash:
        bigInt(
          row.access_hash
        ),

      fileReference,

      mimeType:
        row.mime_type ||
        "video/mp4",

      size:
        row.file_size
          ? bigInt(
              row.file_size
            )
          : null,

      attributes: []
    };

    const updatedAt =
      row.updated_at
        ? new Date(
            row.updated_at
          )
        : new Date();

    lastMediaMessage = {
      id:
        Number(
          row.message_id
        ),

      date:
        Math.floor(
          updatedAt.getTime() /
            1000
        ),

      message: null,

      media:
        inputLocation,

            document:
        restoredDocument
    };

    clearStreamBuffer();

    lastChat = {
      id:
        String(
          row.chat_id
        ),

      title:
        "PMF Media Vault",

      username:
        null,

      messageId:
        Number(
          row.message_id
        )
    };

    console.log(
      "Persisted Telegram media reference restored:"
    );

    console.log(
      JSON.stringify({
        chatId:
          row.chat_id,

        messageId:
          row.message_id,

        documentId:
          row.document_id,

        fileSize:
          row.file_size
      })
    );
  } catch (error) {
    console.error(
      "Failed to restore persisted Telegram media:",
      error
    );
  }
}

async function fetchTelegramBuffer(
  startByte,
  length,
  mediaMessage
) {
  if (
    !mediaMessage?.media ||
    length <= 0
  ) {
    return Buffer.alloc(0);
  }

  const iterator =
    client.iterDownload({
      file:
        mediaMessage.media,

      offset:
        bigInt(startByte),

      limit:
        length,

      chunkSize:
        STREAM_FETCH_CHUNK_SIZE,

      requestSize:
        STREAM_FETCH_REQUEST_SIZE
    });

  const parts = [];
  let total = 0;

  for await (
    const chunk of iterator
  ) {
    const buffer =
      Buffer.from(chunk);

    parts.push(buffer);

    total +=
      buffer.length;
  }

  return Buffer.concat(
    parts,
    total
  );
}

async function prepareNextBuffer(
  startByte,
  totalSize,
  mediaMessage
) {
  if (
    startByte >= totalSize ||
    lastMediaMessage !==
      mediaMessage
  ) {
    return null;
  }

  if (
    nextStreamBuffer &&
    nextStreamBuffer.messageId ===
      mediaMessage.id &&
    nextStreamBuffer.start ===
      startByte
  ) {
    return nextStreamBuffer;
  }

  if (
    nextStreamBufferPromise
  ) {
    return nextStreamBufferPromise;
  }

  const bufferSize =
    startByte === 0
      ? STARTUP_BUFFER_SIZE
      : STREAM_BUFFER_SIZE;

  const length =
    Math.min(
      bufferSize,
      totalSize -
        startByte
    );

  nextStreamBufferPromise =
    (async () => {
      const buffer =
        await fetchTelegramBuffer(
          startByte,
          length,
          mediaMessage
        );

      if (
        lastMediaMessage !==
        mediaMessage
      ) {
        return null;
      }

      nextStreamBuffer = {
        messageId:
          mediaMessage.id,

        start:
          startByte,

        end:
          startByte +
          buffer.length -
          1,

        buffer
      };

      return nextStreamBuffer;
    })();

  try {
    return await nextStreamBufferPromise;
  } catch (error) {
    console.warn(
      "Telegram background prefetch failed:",
      error.message
    );

    return null;
  } finally {
    nextStreamBufferPromise =
      null;
  }
}

function startNextBufferPrefetch(
  currentEnd,
  totalSize,
  mediaMessage
) {
  const nextStart =
    currentEnd + 1;

  if (
    nextStart >= totalSize ||
    lastMediaMessage !==
      mediaMessage ||
    nextStreamBuffer ||
    nextStreamBufferPromise
  ) {
    return;
  }

  void prepareNextBuffer(
    nextStart,
    totalSize,
    mediaMessage
  );
}

async function getStreamBuffer(
  startByte,
  totalSize,
  mediaMessage
) {
  if (
    currentStreamBuffer &&
    currentStreamBuffer.messageId ===
      mediaMessage.id &&
    startByte >=
      currentStreamBuffer.start &&
    startByte <=
      currentStreamBuffer.end
  ) {
    return currentStreamBuffer;
  }

  if (
    nextStreamBuffer &&
    nextStreamBuffer.messageId ===
      mediaMessage.id &&
    startByte >=
      nextStreamBuffer.start &&
    startByte <=
      nextStreamBuffer.end
  ) {
    currentStreamBuffer =
      nextStreamBuffer;

    nextStreamBuffer =
      null;

    return currentStreamBuffer;
  }

  if (
    streamBufferPromise
  ) {
    await streamBufferPromise;

    if (
      currentStreamBuffer &&
      currentStreamBuffer.messageId ===
        mediaMessage.id &&
      startByte >=
        currentStreamBuffer.start &&
      startByte <=
        currentStreamBuffer.end
    ) {
      return currentStreamBuffer;
    }
  }

    const bufferSize =
    startByte === 0
      ? STARTUP_BUFFER_SIZE
      : STREAM_BUFFER_SIZE;

  const length =
    Math.min(
      bufferSize,
      totalSize -
        startByte
    );

  streamBufferPromise =
    (async () => {
      const buffer =
        await fetchTelegramBuffer(
          startByte,
          length,
          mediaMessage
        );

      if (
        lastMediaMessage !==
        mediaMessage
      ) {
        return null;
      }

      currentStreamBuffer = {
        messageId:
          mediaMessage.id,

        start:
          startByte,

        end:
          startByte +
          buffer.length -
          1,

        buffer
      };

      return currentStreamBuffer;
    })();

  try {
    return await streamBufferPromise;
  } finally {
    streamBufferPromise =
      null;
  }
}

async function connectTelegram() {
  try {
    if (
      !apiId ||
      !apiHash ||
      !botToken
    ) {
      throw new Error(
        "Telegram environment variables are missing"
      );
    }

    console.log(
      "Connecting PMF Telegram Bridge to Telegram..."
    );

    await client.start({
      botAuthToken:
        botToken,

      onError:
        (error) => {
          console.error(
            "Telegram client error:",
            error
          );
        }
    });

    telegramBot =
      await client.getMe();

    telegramStatus =
      "ready";

    console.log(
      `Telegram connected as @${
        telegramBot.username ||
        "unknown"
      }`
    );

    await restoreLatestTelegramMedia();

    client.addEventHandler(
      async (event) => {
        try {
          const message =
            event.message;

          if (!message) {
            return;
          }

          const chat =
            await message.getChat();

          if (!chat) {
            return;
          }

          const chatId =
            chat.id
              ? String(chat.id)
              : null;

          const title =
            chat.title ||
            null;

          const username =
            chat.username ||
            null;

          lastChat = {
            id:
              chatId,

            title,

            username,

            messageId:
              message.id
          };

          console.log(
            "Telegram message received:"
          );

          console.log(
            JSON.stringify(
              lastChat
            )
          );

          if (
            chatId !==
            PMF_MEDIA_CHAT_ID
          ) {
            return;
          }

          const media =
            describeMedia(
              message
            );

          if (!media) {
            console.log(
              "PMF Media Vault message has no supported media."
            );

            return;
          }

          lastMediaMessage =
            message;

          clearStreamBuffer();

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
    telegramStatus =
      "error";

    telegramError =
      error.message;

    console.error(
      "Telegram connection failed:",
      error
    );
  }
}

app.get(
  "/",
  (_req, res) => {
    res.json({
      name:
        "PMF Telegram Bridge",

      status:
        "online",

      version:
        "2.6.0"
    });
  }
);

app.get(
  "/health",
  (_req, res) => {
    res.json({
      status:
        "ok"
    });
  }
);

app.get(
  "/telegram-status",
  (_req, res) => {
    res.json({
      status:
        telegramStatus,

      connected:
        telegramStatus ===
        "ready",

      bot:
        telegramBot
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
      chat:
        lastChat
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
            found:
              false,

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
            found:
              false,

            error:
              "No media has been captured or restored yet."
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
          found:
            false,

          error:
            error.message
        });
    }
  }
);

async function streamTelegramMedia(req, res) {
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

      let mediaMessage =
        lastMediaMessage;

      if (req.params.movieId) {
        try {
          mediaMessage =
            await getMappedTelegramMedia(
              req.params.movieId
            );
        } catch (error) {
          console.error(
            "Movie-specific Telegram media lookup failed:",
            error
          );

          return res
            .status(500)
            .json({
              error:
                error.message
            });
        }

        if (!mediaMessage?.media) {
          return res
            .status(404)
            .json({
              error:
                "No Telegram media is mapped to movie " +
                req.params.movieId +
                "."
            });
        }

        lastMediaMessage =
          mediaMessage;

        clearStreamBuffer();
      }

      if (!mediaMessage?.media) {
        return res
          .status(404)
          .json({
            error:
              "No media has been captured or restored yet."
          });
      }

      const media =
        describeMedia(
          mediaMessage
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
          (
            match[1] === "" &&
            match[2] === ""
          )
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
          match[1] === ""
        ) {
          const suffixLength =
            Number(
              match[2]
            );

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
            Number(
              match[1]
            );

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
              Number(
                match[2]
              );

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
        partial
          ? 206
          : 200
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
          "no-store",

        "X-PMF-Stream":
          "2.6.0"
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

      res.flushHeaders?.();

      let bufferState =
        await getStreamBuffer(
          startByte,
          totalSize,
          mediaMessage
        );

      if (
        !bufferState ||
        !bufferState.buffer.length
      ) {
        throw new Error(
          "Unable to prepare Telegram stream buffer."
        );
      }

      let currentByte =
        startByte;

      const streamEnd =
        endByte;

      while (
        currentByte <=
          streamEnd &&
        !res.destroyed
      ) {
        if (
          !bufferState ||
          bufferState.messageId !==
            mediaMessage.id ||
          currentByte <
            bufferState.start ||
          currentByte >
            bufferState.end
        ) {
          bufferState =
            await getStreamBuffer(
              currentByte,
              totalSize,
              mediaMessage
            );

          if (
            !bufferState ||
            !bufferState.buffer.length
          ) {
            throw new Error(
              "Unable to refill Telegram stream buffer."
            );
          }
        }

        const offsetInBuffer =
          currentByte -
          bufferState.start;

        const available =
          bufferState.buffer.length -
          offsetInBuffer;

        const remaining =
          streamEnd -
          currentByte +
          1;

        const bytesToWrite =
          Math.min(
            DELIVERY_CHUNK_SIZE,
            available,
            remaining
          );

        const slice =
          bufferState.buffer.subarray(
            offsetInBuffer,
            offsetInBuffer +
              bytesToWrite
          );

        if (
          !res.write(slice)
        ) {
          await new Promise(
            (resolve) =>
              res.once(
                "drain",
                resolve
              )
          );
        }

        currentByte +=
          bytesToWrite;

        const remainingInBuffer =
          bufferState.end -
          currentByte +
          1;

        if (
          remainingInBuffer <=
          STREAM_PREFETCH_TRIGGER
        ) {
          startNextBufferPrefetch(
            bufferState.end,
            totalSize,
            mediaMessage
          );
        }

        if (
          currentByte >
            bufferState.end &&
          currentByte <=
            streamEnd
        ) {
          if (
            nextStreamBuffer &&
            nextStreamBuffer.messageId ===
              mediaMessage.id &&
            nextStreamBuffer.start ===
              currentByte
          ) {
            currentStreamBuffer =
              nextStreamBuffer;

            nextStreamBuffer =
              null;

            bufferState =
              currentStreamBuffer;

            startNextBufferPrefetch(
              bufferState.end,
              totalSize,
              mediaMessage
            );
          } else {
            bufferState =
              await getStreamBuffer(
                currentByte,
                totalSize,
                mediaMessage
              );

            if (
              !bufferState ||
              !bufferState.buffer.length
            ) {
              throw new Error(
                "Unable to refill Telegram stream buffer."
              );
            }
          }
        }

        await new Promise(
          (resolve) =>
            setImmediate(resolve)
        );
      }

      if (
        !res.destroyed
      ) {
        res.end();
      }
    } catch (error) {
      console.error(
        "Telegram media streaming failed:",
        error
      );

      if (
        !res.headersSent
      ) {
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

app.get(
  "/telegram-media",
  streamTelegramMedia
);

app.get(
  "/telegram-media/:movieId",
  streamTelegramMedia
);

app.listen(
  PORT,
  () => {
    console.log(
      `PMF Telegram Bridge listening on port ${PORT}`
    );

    void connectTelegram();
  }
);
