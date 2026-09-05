import { describe, it, expect } from "vitest";
import { filterHarnessModels, renderModelsTree } from "../src/cli/commands/models.js";
import type { HarnessModels } from "../src/core/models.js";

describe("filterHarnessModels", () => {
  const sampleData: HarnessModels[] = [
    {
      agent: "codex",
      available: true,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          models: [
            { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", provider: "openai" },
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
          ],
        },
      ],
    },
    {
      agent: "claude",
      available: true,
      providers: [
        {
          provider: "anthropic",
          displayName: "Anthropic",
          models: [
            { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", aliases: ["sonnet"] },
            { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", aliases: ["opus"] },
          ],
        },
      ],
    },
  ];

  it("filters by provider", () => {
    const filtered = filterHarnessModels(sampleData, { provider: "anthropic" });
    expect(filtered.find((h) => h.agent === "claude")?.providers.length).toBe(1);
    expect(filtered.find((h) => h.agent === "codex")?.providers.length).toBe(0);
  });

  it("filters by search term in model id", () => {
    const filtered = filterHarnessModels(sampleData, { search: "luna" });
    const codex = filtered.find((h) => h.agent === "codex");
    expect(codex?.providers[0].models.length).toBe(1);
    expect(codex?.providers[0].models[0].id).toBe("gpt-5.6-luna");
  });

  it("filters by search term matching an alias", () => {
    const filtered = filterHarnessModels(sampleData, { search: "sonnet" });
    const claude = filtered.find((h) => h.agent === "claude");
    expect(claude?.providers[0].models.length).toBe(1);
    expect(claude?.providers[0].models[0].id).toBe("claude-sonnet-5");
  });
});

describe("renderModelsTree", () => {
  it("renders tree with status, provider, and models", () => {
    const sampleData: HarnessModels[] = [
      {
        agent: "codex",
        available: true,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            models: [
              { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", provider: "openai", isDefault: true },
            ],
          },
        ],
      },
    ];

    const rendered = renderModelsTree(sampleData, {});
    expect(rendered).toContain("codex");
    expect(rendered).toContain("OpenAI");
    expect(rendered).toContain("gpt-5.6-luna");
    expect(rendered).toContain("(default)");
  });

  it("truncates providers with more than 8 models when not in --all mode", () => {
    const models = Array.from({ length: 15 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      provider: "openrouter",
    }));

    const sampleData: HarnessModels[] = [
      {
        agent: "omp",
        available: true,
        providers: [
          {
            provider: "openrouter",
            displayName: "OpenRouter",
            models,
          },
        ],
      },
    ];

    const rendered = renderModelsTree(sampleData, {});
    expect(rendered).toContain("... and 7 more models");

    const renderedAll = renderModelsTree(sampleData, { all: true });
    expect(renderedAll).not.toContain("... and 7 more models");
    expect(renderedAll).toContain("model-14");
  });

  it("prioritizes default and aliased models at the top before truncation", () => {
    const models = Array.from({ length: 15 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      provider: "anthropic",
    }));

    // Model at index 12 is default, model at index 14 has alias
    models[12].isDefault = true;
    models[14].aliases = ["flagship"];

    const sampleData: HarnessModels[] = [
      {
        agent: "claude",
        available: true,
        providers: [
          {
            provider: "anthropic",
            displayName: "Anthropic",
            models,
          },
        ],
      },
    ];

    const rendered = renderModelsTree(sampleData, {});
    // Both model-12 (default) and model-14 (alias) must appear in the top 8 visible models
    expect(rendered).toContain("model-12");
    expect(rendered).toContain("(default)");
    expect(rendered).toContain("model-14");
    expect(rendered).toContain("[alias: flagship]");
    expect(rendered).toContain("... and 7 more models");
  });

  it("renders unavailable harnesses with error message", () => {
    const sampleData: HarnessModels[] = [
      {
        agent: "codex",
        available: false,
        error: "codex binary not found",
        providers: [],
      },
    ];

    const rendered = renderModelsTree(sampleData, {});
    expect(rendered).toContain("codex");
    expect(rendered).toContain("not available: codex binary not found");
  });

  it("renders available harness with 0 models cleanly", () => {
    const sampleData: HarnessModels[] = [
      {
        agent: "claude",
        available: true,
        providers: [],
      },
    ];

    const rendered = renderModelsTree(sampleData, {});
    expect(rendered).toContain("claude");
    expect(rendered).toContain("No models discovered");
  });
});

