import { classifyAgentFailure } from "../../../src/agent.js";

export function connectionFailureMessage(error: unknown, timedOut: boolean): string {
    if (timedOut) return "连接测试超过 20 秒。请检查网络、API 地址和服务状态后重试。";
    switch (classifyAgentFailure(error).category) {
        case "authentication":
            return "认证失败。请检查当前路由的 API Key 和认证方式。";
        case "rate-limit":
            return "请求受到限流。请稍后重试，或检查服务商额度。";
        case "network":
            return "无法连接到模型服务。请检查网络、API 地址和代理设置。";
        case "provider":
            return "模型服务拒绝了测试请求。请检查模型名称、API 协议和地址。";
        case "internal":
            return "连接测试未完成。请检查当前设置后重试。";
    }
}
