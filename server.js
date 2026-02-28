const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const distPath = path.join(__dirname, "frontend", "dist");
app.use(express.static(distPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
