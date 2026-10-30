// Shapes returned by the FastAPI backend. Keep in step with backend/app/schemas.py.

export interface RoomOut {
  id: string;
  status: string;
  created_at: string;
  expires_at: string;
}

export interface ParticipantOut {
  id: string;
  display_name: string;
  joined_at: string;
}

export interface MemberOut extends ParticipantOut {
  online: boolean;
}

/** Returned by create and join. The server keeps only hashes, so the client holds the code and token. */
export interface RoomSession {
  room: RoomOut;
  participant: ParticipantOut;
  code: string;
  token: string;
}

export interface RoomDetails {
  room: RoomOut;
  me: ParticipantOut;
  participants: MemberOut[];
}

/** What a reply quotes: the start of a message, or a shared file's name and type. */
export interface ReplyOut {
  kind: "message" | "file";
  id: string;
  participant_id: string;
  display_name: string;
  text: string;
  mime_type: string | null;
}

export interface MessageOut {
  id: string;
  participant_id: string;
  display_name: string;
  content: string;
  created_at: string;
  reply_to: ReplyOut | null;
}

export interface MessagePage {
  messages: MessageOut[];
  has_more: boolean;
}

export interface FileOut {
  id: string;
  participant_id: string;
  display_name: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface FileList {
  files: FileOut[];
  has_more: boolean;
}

// WebSocket frames. Only the server-to-client types the UI reacts to are typed precisely.
export type ServerFrame =
  | { type: "ready"; me: ParticipantOut; participants: MemberOut[] }
  | { type: "message.new"; message: MessageOut; client_id: string | null }
  | { type: "participant.joined"; participant: ParticipantOut }
  | { type: "participant.left"; participant_id: string }
  | { type: "presence"; participant_id: string; online: boolean }
  | { type: "file.ready"; file: FileOut }
  | { type: "room.expired" }
  | { type: "error"; code: string; detail: string; client_id: string | null }
  | { type: "pong" };
