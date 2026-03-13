import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LOCAL ONLY — enables access via ngrok /dev/ path. Do NOT commit!
  basePath: '/dev',
  assetPrefix: '/dev',
};

export default nextConfig;
