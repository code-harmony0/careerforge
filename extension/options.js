// extension/options.js
const DEFAULT_SERVER = "http://localhost:3000";

async function load() {
  const { serverUrl = DEFAULT_SERVER, cliId = "" } = await chrome.storage.local.get(["serverUrl", "cliId"]);
  document.getElementById("serverUrl").value = serverUrl;

  const select = document.getElementById("cliId");
  try {
    const res = await fetch(`${serverUrl}/api/clis`);
    const clis = await res.json();
    select.innerHTML = "";
    for (const c of Array.isArray(clis) ? clis : clis.clis || []) {
      const option = document.createElement("option");
      option.value = c.id;
      option.textContent = c.name || c.id;
      select.appendChild(option);
    }
    if (cliId) select.value = cliId;
  } catch {
    select.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `could not reach ${serverUrl} — is career-ops running?`;
    select.appendChild(option);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const serverUrl = document.getElementById("serverUrl").value.trim().replace(/\/+$/, "") || DEFAULT_SERVER;
  const cliId = document.getElementById("cliId").value;
  await chrome.storage.local.set({ serverUrl, cliId });
  document.getElementById("status").textContent = "Saved.";
  setTimeout(() => (document.getElementById("status").textContent = ""), 1500);
});

load();
