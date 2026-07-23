# LibTV product facts used for the AI-amnTV redesign

Observed on 2026-07-24 in the signed-in LibTV web product. These notes are
product research, not a specification to copy its visual design.

## Verified product structure

- The home page combines recent projects, a natural-language creation entry,
  reusable Skills, and a public gallery whose projects expose a read-only
  creation process.
- The primary project surface is an infinite node canvas, not a staged admin
  checklist.
- A populated project contains groups, image nodes, video nodes, derivation
  branches, reference edges, zoom controls, a minimap, grid snapping, history,
  asset management, and automatic canvas arrangement.
- The add-node menu exposes text, image, video, video composition, director
  desk, audio, script, asset-library, upload, and generation-history entries.
- The toolbox contains reusable visual/camera/transition subflows such as
  orbit moves, product entrances, Live 2D, travel transitions, hero shots, and
  nine-grid storyboard presets.
- The right-side Agent can reference the current workflow, nodes, and resources
  with `@`, select a model, attach files, and invoke a Skill.
- Workflow and storyboard are two views of the same project. Storyboard view
  organizes the graph's text, image, and video outputs into production-readable
  collections while retaining their reference relationships.
- Public creation processes are read-only and can be copied into a new project.
- Projects are folder-managed and open their canvases in dedicated tabs.

## Design consequences for AI-amnTV

- The production graph becomes the default command surface.
- Import is a first-class canvas action, not a hidden setup step.
- Existing script, cast, storyboard, voice, keyframe, video, evaluation, cost,
  and delivery state should appear as linked nodes with status and blockers.
- Specialist editors remain available from node actions instead of defining the
  whole information architecture.
- Agent assistance is contextual to the selected node and must propose a plan
  before any paid or destructive execution.
- AI-amnTV keeps its differentiators: local project files as the source of
  truth, explicit human gates, character/voice continuity, evidence-backed QA,
  cost visibility, platform duration checks, and recoverable retakes.

