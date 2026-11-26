// Every test runs as if the computer were in the shop's own zone, so a routine's time never gains a zone note because of the
// machine the suite happens to run on. A test about the note sets another zone with `pinComputerZone` and puts it back.
import { beforeEach } from "vitest";
import { pinComputerZone } from "./lib/zone";

beforeEach(() => pinComputerZone("Asia/Bangkok"));
