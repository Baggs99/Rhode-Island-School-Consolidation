const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const distPath = path.join(__dirname, "frontend", "dist");

if (!fs.existsSync(distPath)) {
  console.error(`FATAL: frontend/dist not found at ${distPath}. Run npm run build first.`);
  process.exit(1);
}

app.use(express.static(distPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  const geoFile = path.join(distPath, "geo", "districts.geojson");
  const hasGeo = fs.existsSync(geoFile);
  console.log(`Server running on port ${PORT}`);
  console.log(`Serving: ${distPath}`);
  console.log(`districts.geojson present: ${hasGeo}`);
});
