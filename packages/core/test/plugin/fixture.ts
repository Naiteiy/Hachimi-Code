import { AgentV2 } from "@hachimi-code/core/agent"
import { AISDK } from "@hachimi-code/core/aisdk"
import { Catalog } from "@hachimi-code/core/catalog"
import { CommandV2 } from "@hachimi-code/core/command"
import { Credential } from "@hachimi-code/core/credential"
import { AppNodeBuilder } from "@hachimi-code/core/effect/app-node-builder"
import { LayerNodePlatform } from "@hachimi-code/core/effect/app-node-platform"
import { LayerNode } from "@hachimi-code/core/effect/layer-node"
import { EventV2 } from "@hachimi-code/core/event"
import { FileSystem } from "@hachimi-code/core/filesystem"
import { FSUtil } from "@hachimi-code/core/fs-util"
import { Integration } from "@hachimi-code/core/integration"
import { Location } from "@hachimi-code/core/location"
import { Npm } from "@hachimi-code/core/npm"
import { PluginV2 } from "@hachimi-code/core/plugin"
import { Reference } from "@hachimi-code/core/reference"
import { SkillV2 } from "@hachimi-code/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
