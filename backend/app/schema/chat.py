from pydantic import BaseModel


class ChatRequest(BaseModel):
    username: str
    message: str


class ChatResponse(BaseModel):
    reply: str
