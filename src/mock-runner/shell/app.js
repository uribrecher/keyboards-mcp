// Shell app — model picker

(async function init() {
  const listEl = document.getElementById("model-list");
  const loadingEl = document.getElementById("loading");

  const models = await window.mockRunnerAPI.getModels();

  if (models.length === 0) {
    listEl.innerHTML = '<p style="color:#888">No keyboard models found.</p>';
    return;
  }

  for (const model of models) {
    const card = document.createElement("div");
    card.className = "model-card";
    card.innerHTML = `
      <div class="model-name">${model.displayName}</div>
      <div class="model-manufacturer">${model.manufacturer}</div>
    `;
    card.addEventListener("click", async () => {
      listEl.classList.add("hidden");
      loadingEl.classList.remove("hidden");
      await window.mockRunnerAPI.selectModel(model.id);
    });
    listEl.appendChild(card);
  }
})();
