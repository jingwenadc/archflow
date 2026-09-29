import type { Message } from "@/lib/api";

export function ConversationMessage({ message }: { message: Message }) {
  return message.role === "user" ? (
    <div className="message-row user-message">
      <div className="message-bubble"><p>{message.content}</p></div>
      <span className="message-avatar user-avatar">我</span>
    </div>
  ) : (
    <div className="message-row assistant-message">
      <span className="message-avatar archflow-avatar">AF</span>
      <div className="message-stack">
        <div className="message-bubble"><p>{message.content}</p></div>
        <span className="message-meta">ArchFlow</span>
      </div>
    </div>
  );
}
