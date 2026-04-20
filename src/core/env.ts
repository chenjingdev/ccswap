export function buildClaudeEnv(claudeConfigDir?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (claudeConfigDir) {
    env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
  } else {
    delete env["CLAUDE_CONFIG_DIR"];
  }
  delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  return env;
}
