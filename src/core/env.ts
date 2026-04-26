import type { AccountData, AuthMode } from "./config.js";
import {
  activateAccountCredential,
  getAccountCredential,
  parseStoredCredential,
} from "./credentials.js";

export interface ClaudeEnvOptions {
  oauthToken?: string | null;
}

export interface ClaudeLaunchAuth {
  env: NodeJS.ProcessEnv;
  error: string | null;
}

export function buildClaudeEnv(options: ClaudeEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["CLAUDE_CONFIG_DIR"];
  delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  delete env["ANTHROPIC_BASE_URL"];
  delete env["ANTHROPIC_API_BASE_URL"];
  if (options.oauthToken) {
    env["CLAUDE_CODE_OAUTH_TOKEN"] = options.oauthToken;
  }
  return env;
}

export function buildClaudeLaunchAuth(account: AccountData, authMode: AuthMode): ClaudeLaunchAuth {
  if (authMode === "oauth_env") {
    const credential = getAccountCredential(account);
    if (!credential) {
      return {
        env: buildClaudeEnv(),
        error: `[ccswap] Account '${account.name}' has no saved Claude login. Run: ccswap login ${account.name}\n`,
      };
    }
    const parsed = parseStoredCredential(credential.secret);
    if (!parsed.access_token) {
      return {
        env: buildClaudeEnv(),
        error: `[ccswap] Account '${account.name}' has no OAuth access token for auth_mode=oauth_env.\n`,
      };
    }
    return {
      env: buildClaudeEnv({ oauthToken: parsed.access_token }),
      error: null,
    };
  }

  const activated = activateAccountCredential(account);
  if (!activated) {
    return {
      env: buildClaudeEnv(),
      error: `[ccswap] Account '${account.name}' has no saved Claude login. Run: ccswap login ${account.name}\n`,
    };
  }
  return {
    env: buildClaudeEnv(),
    error: null,
  };
}
