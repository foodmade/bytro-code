# Formal model-trigger parity design

## Goal

Make the Community Edition chat-input model trigger match the formal edition's
compact presentation while keeping Community Edition's provider, credential,
and model-selection boundaries unchanged.

The highlighted control must present:

- the active provider icon;
- the active model label; and
- for Claude and Codex profiles, a separate reasoning/effort button with the
  active level and the existing effort timeline popover.

## Scope

The change is limited to
`src/components/chat/model-selector.tsx`.

The existing Community Edition model catalog, local-profile filtering, Ollama
loading, conversation/pane-scoped model persistence, settings navigation, and
model dropdown remain authoritative.

The existing formal-edition assets and shared components already present in
Community Edition may be reused:

- `PLATFORM_ICONS`;
- `EffortTimelinePopover`;
- `isPeakReasoningVisualActive`;
- `supportsCodexMaxReasoning`; and
- the existing effort timeline CSS.

## Trigger behavior

The current bordered model button is replaced with the formal edition's compact
two-part trigger:

1. The model button opens the existing Community Edition model dropdown.
2. For Claude and Codex, the effort button closes the model dropdown and toggles
   `EffortTimelinePopover`.
3. Opening the model dropdown closes the effort popover.
4. Providers without model-option support display only the model button.
5. Compact layouts collapse labels using the existing `collapseStyle` behavior.

The model label continues to come from the active Community Edition profile and
model list. A profile requiring an explicit local selection keeps an accessible
warning title and label rather than silently selecting a model.

## Explicit exclusions

This change must not import or restore:

- `useAuthStore`;
- Bytro account or official-model state;
- `OfficialModelsConfig` or official-model branches;
- shared/private provider credentials;
- cloud usage or billing behavior; or
- automatic remote model fetching.

The permission selector remains unchanged. Differences such as “自动编辑” versus
“全自动” are persisted permission state, not part of this visual fix.

## Verification

- TypeScript compilation succeeds.
- Existing frontend tests pass.
- Community-boundary checks pass.
- Static checks confirm that the modified component does not reference auth or
  official-model state.
- The rendered trigger has no standalone bordered surface and exposes separate
  model and effort buttons for Claude/Codex.
