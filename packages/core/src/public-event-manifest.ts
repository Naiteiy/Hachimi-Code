export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@hachimi-code/schema/event"
import { EventManifest } from "@hachimi-code/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
