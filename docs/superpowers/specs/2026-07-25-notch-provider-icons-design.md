# Notch provider icons design

## Goal

Make the Community Edition notch display the icon for the platform that owns
the active model instead of a generated initial.

Examples:

- Opus, Sonnet, and Fable models display the Claude icon.
- GPT and Codex models display the OpenAI icon.
- Ollama models display the Ollama icon.

## Data flow

The existing notch state already carries `provider`, derived from the active
conversation model by `useNotchBroadcaster`. The overlay continues to consume
that field without adding a model ID or changing the cross-window state
protocol.

`ProviderLogo` resolves `provider` through the existing `PLATFORM_ICONS` map.
All current `ProviderLogo` call sites therefore update together, including the
collapsed notch, expanded status panel, and approval panels.

## Presentation

When an icon exists, `ProviderLogo` renders it inside the formal edition's
round, translucent holder with the provider accent glow. The supplied `size`
continues to control the icon dimensions, while the holder remains four pixels
larger.

The icon is decorative because the provider name remains available through the
wrapper's accessible label and title. It is not draggable.

If an icon is unavailable, the component renders the existing provider-colored
glowing circle. It does not invent or reuse another provider's icon.

## Scope boundaries

This change is limited to the notch overlay's provider-logo rendering and a
static regression check. It does not change:

- model selection;
- persisted provider, model, MCP, or API-key configuration;
- notch status, timing, token, stop, approval, or window behavior;
- the notch bridge payload; or
- Community Edition's account and official-model boundaries.

## Verification

- TypeScript compilation succeeds.
- Existing frontend tests pass.
- Community-boundary checks pass.
- The production frontend build succeeds.
- Static checks require the notch overlay to import `PLATFORM_ICONS`, resolve
  the current provider through that map, and render the resolved image.
