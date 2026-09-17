import Anthropic from "@anthropic-ai/sdk";
import { executeTool } from "./tools.js";

const MODEL = process.env.MINI_MODEL || "deepseek-mini-1-20260912";

const SYSTEM_PROMPT =
    "You are Mini DeepSeek, a small coding assistant that helps with software " +
    "tasks. Use the tools to read and change files. Keep answers short.";

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];

    constructor() {
        this.client = new Anthropic({
            baseURL : process.env.ANTHROPIC_BASE_URL,
            apiKey : process.env.ANTHROPIC_API_KEY
        })
    }

    async chat(userText: string) : Promise<void> {
        this.messages.push({ role: "user", content: userText });
        // agent loop
        while (true) {
            let systemPrompt = SYSTEM_PROMPT;
            const request = {
                model: MODEL,
                max_tokens: 4096,
                system: systemPrompt,
                messages: this.messages
            };
            const reply = await this.client.messages.create(request);
            for(const block of reply.content) {
                if(block.type === "text") process.stdout.write(block.text);
            }
            process.stdout.write("\n");
            // Record the assistant's full reply (text + any tool calls)
            this.messages.push({ role: "assistant", content: reply.content });
            // Check for tool calls
            const toolUses = reply.content.filter(
                (block) : block is Anthropic.ToolUseBlock => block.type === "tool_use"
            );
            // if no tool calls, the model is done with this turn
            if(!toolUses.length) return;
            for(const toolUse of toolUses) {
                console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
                // Run the tool and send the output back as one user message
                const output = await executeTool(toolUse.name, toolUse.input as Record<string, any>);
                this.messages.push({ role: "user", content: [{ type: "text", text: output }] });
            }
        }
    }
}
