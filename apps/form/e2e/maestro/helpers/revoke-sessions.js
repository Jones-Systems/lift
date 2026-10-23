if (!/^http:[/][/]127[.]0[.]0[.]1:[0-9]+$/.test(E2E_CONTROL_URL) || !E2E_CONTROL_TOKEN) {
  throw new Error("A loopback test control listener and invocation token are required");
}
var response = http.post(E2E_CONTROL_URL + "/revoke-sessions", {
  headers: { Authorization: "Bearer " + E2E_CONTROL_TOKEN, "Content-Type": "application/json" },
  body: "{}"
});
if (response.status !== 200) {
  throw new Error("Test session revocation failed with status " + response.status);
}
