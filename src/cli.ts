import { Agent } from "./agent.js";
import * as readline from "node:readline";

const agent = new Agent();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function prompt(): void {
    rl.question("You: ", async (text) => {
        if (text.trim() === "" || text.trim() === "exit") {
            rl.close();
            return;
        }
        await agent.chat(text);
        prompt();
    });
}

prompt();
