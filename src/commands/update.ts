#!/usr/bin/env node

/**
 * ai-bridge update - Check for and install updates to the CLI.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.join(__dirname, "../..");

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));
const PACKAGE_NAME = pkgJson.name;
const CURRENT_VERSION = pkgJson.version;

// ANSI color codes
const COLORS = {
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  bold: "\x1b[1m"
};

function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color] || ""}${text}${COLORS.reset}`;
}

export async function updateCommand(forceUpdate: boolean, skipConfirm: boolean): Promise<void> {
  console.log(colorize(`📦 ${PACKAGE_NAME}`, "cyan"));
  console.log(`   Current version: ${CURRENT_VERSION}`);
  console.log("");

  // Check for remote latest version
  console.log("🔍 Checking for updates...");
  
  let latestVersion: string;
  try {
    latestVersion = await getLatestVersion();
  } catch (error) {
    console.error(colorize(`❌ Failed to check for updates: ${(error as Error).message}`, "red"));
    process.exit(1);
  }

  console.log(`   Latest version:  ${latestVersion}`);
  console.log("");

  // Compare versions
  if (!forceUpdate && !isNewerVersion(latestVersion, CURRENT_VERSION)) {
    console.log(colorize("✅ You are already on the latest version!", "green"));
    return;
  }

  if (forceUpdate) {
    console.log(colorize("⚡ Force update requested", "yellow"));
  } else {
    console.log(colorize(`⬆️  Update available: ${CURRENT_VERSION} → ${latestVersion}`, "green"));
  }

  console.log("");

  // Confirm update
  if (!skipConfirm) {
    const shouldUpdate = await confirmUpdate(latestVersion);
    if (!shouldUpdate) {
      console.log("Update cancelled.");
      return;
    }
  }

  // Perform update
  console.log("");
  console.log(colorize("🚀 Installing update...", "cyan"));
  console.log("");

  try {
    await performUpdate();
    console.log("");
    console.log(colorize("✅ Update completed successfully!", "green"));
    console.log("");
    console.log("   Run 'ai-bridge --version' to verify the new version.");
  } catch (error) {
    console.error("");
    console.error(colorize(`❌ Update failed: ${(error as Error).message}`, "red"));
    console.error("");
    console.error("   You can try updating manually with:");
    console.error(`   npm install -g ${PACKAGE_NAME}@latest`);
    process.exit(1);
  }
}

async function getLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use npm view to get latest version
    try {
      const result = execSync(`npm view ${PACKAGE_NAME} version --json`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      
      // npm view returns a quoted string JSON
      const version = JSON.parse(result.trim());
      resolve(version);
    } catch (error) {
      // If failed, try fetching from registry API
      fetchLatestFromRegistry()
        .then(resolve)
        .catch(reject);
    }
  });
}

async function fetchLatestFromRegistry(): Promise<string> {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
    
    https.get(url, { timeout: 10000 }, (res: any) => {
      let data = "";
      
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.version) {
            resolve(json.version);
          } else {
            reject(new Error("Invalid response from registry"));
          }
        } catch (error) {
          reject(new Error(`Failed to parse registry response: ${(error as Error).message}`));
        }
      });
    }).on("error", (error: Error) => {
      reject(new Error(`Network error: ${error.message}`));
    }).on("timeout", () => {
      reject(new Error("Request timed out"));
    });
  });
}

function isNewerVersion(latest: string, current: string): boolean {
  // Simple version comparison
  const parseVersion = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);
  
  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    
    if (l > c) return true;
    if (l < c) return false;
  }
  
  return false; // Same version
}

async function confirmUpdate(version: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  try {
    const answer = await rl.question(
      colorize(`Do you want to update to version ${version}? (Y/n): `, "yellow")
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function performUpdate(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Detect package manager
    const packageManager = detectPackageManager();
    console.log(`   Using package manager: ${colorize(packageManager, "cyan")}`);
    console.log("");
    
    let cmd: string, args: string[];
    
    switch (packageManager) {
      case "pnpm":
        cmd = "pnpm";
        args = ["add", "-g", `${PACKAGE_NAME}@latest`];
        break;
      case "yarn":
        cmd = "yarn";
        args = ["global", "add", `${PACKAGE_NAME}@latest`];
        break;
      case "npm":
      default:
        cmd = "npm";
        args = ["install", "-g", `${PACKAGE_NAME}@latest`];
        break;
    }
    
    console.log(`   Running: ${colorize(`${cmd} ${args.join(" ")}`, "cyan")}`);
    console.log("");
    
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: true
    });
    
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Exit code ${code}`));
      }
    });
    
    child.on("error", (error) => {
      reject(error);
    });
  });
}

function detectPackageManager(): string {
  // Detect package manager by analyzing the path of ai-bridge command
  try {
    const binPath = execSync("which ai-bridge", { encoding: "utf-8" }).trim();
    
    if (binPath.includes("pnpm")) return "pnpm";
    if (binPath.includes("yarn")) return "yarn";
    if (binPath.includes(".npm")) return "npm";
  } catch {
    // Ignore error
  }
  
  // Fallback: Check for lockfiles in global directories
  try {
    const globalPath = execSync("npm root -g", { encoding: "utf-8" }).trim();
    if (fs.existsSync(path.join(globalPath, "..", "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(globalPath, "..", "yarn.lock"))) return "yarn";
  } catch {
    // Ignore error
  }
  
  return "npm"; // Default fallback
}
