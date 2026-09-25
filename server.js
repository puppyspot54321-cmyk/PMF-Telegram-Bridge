import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.json({
    name: "PMF Telegram Bridge",
    status: "online",
    version: "1.0.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

app.listen(PORT, () => {
  console.log(`PMF Telegram Bridge listening on port ${PORT}`);
});
