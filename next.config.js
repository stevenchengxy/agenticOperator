const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Let LAN devices load /_next/* dev assets — Next 16 blocks cross-origin dev
  // requests from non-localhost origins (403), which breaks hydration when a
  // teammate opens the app via this machine's LAN IP.
  allowedDevOrigins: ["192.168.1.106", "192.168.*.*", "10.*.*.*"],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

module.exports = nextConfig;
