import { Config } from "@remotion/cli/config";

// Serve projects/ as the public dir so compositions can staticFile()
// project-relative paths like "<project>/input/clip.mp4".
Config.setPublicDir("./projects");
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
