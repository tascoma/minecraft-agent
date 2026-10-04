from fastapi import APIRouter

from app.agents.agent import agent
from app.schema.chat import ChatRequest, ChatResponse

router = APIRouter()


@router.post('/chat')
async def chat(request: ChatRequest) -> ChatResponse:
    result = await agent.run(f'{request.username}: {request.message}')
    return ChatResponse(reply=result.output)
