export const codexAccess = `header.${Buffer.from(
  JSON.stringify({
    exp: 2000000000,
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  }),
).toString("base64url")}.signature`;
export const codexAuth = JSON.stringify({
  tokens: { access_token: codexAccess, refresh_token: "test-refresh", account_id: "test-account" },
});
