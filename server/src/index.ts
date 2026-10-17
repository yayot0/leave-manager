import "./config/env.js";
import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get("/api/health", (_req, res) => {
res.json({ status: "ok" });
});

app.listen(PORT, () => {
console.log(`API running on http://localhost:${PORT}`);
});