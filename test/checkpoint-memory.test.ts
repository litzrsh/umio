import { MemoryCheckpointStore } from "../src/index.js";
import { checkpointStoreContract } from "./checkpoint-contract.js";

checkpointStoreContract("MemoryCheckpointStore", (now) => new MemoryCheckpointStore({ now }));
