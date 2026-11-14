"""Generate real speech and durable chat attachments in an explicitly disposable home."""
import argparse
import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path


async def seed(expected_home: Path) -> dict:
    assert os.environ.get('KX_NATIVE_AUDIO_QA') == '1', 'Disposable QA opt-in required'
    from deeptutor.runtime.home import get_runtime_home
    assert get_runtime_home() == expected_home.resolve(), 'Wrong runtime home; do not seed learner data'
    from deeptutor.core.stream import StreamEvent, StreamEventType
    from deeptutor.services.config.provider_runtime import resolve_tts_runtime_config
    from deeptutor.services.session import get_session_store
    from deeptutor.services.session.artifact_attachments import artifact_attachments
    from deeptutor.services.workspace import get_content_workspace_service
    from deeptutor.tools.media_gen_tool import SpeechgenTool

    # The CI makes a real free-service request, never a paid provider or a fake audio response.
    config = resolve_tts_runtime_config()
    assert config.adapter == 'edge', 'QA requires the configured free Edge provider'
    store = get_session_store()
    session = await store.create_session(title='合成英语听力验收')
    session_id = session['id']
    text = 'This is an English listening test. Two plus three equals five. Listen carefully, and choose the correct answer.'
    content = text
    user_id = await store.add_message(session_id, 'user', '请把下面英文生成可播放的听力音频：' + text, capability='chat')
    workspace = get_content_workspace_service()
    binding = workspace.default_binding()
    assert binding.root.resolve().is_relative_to(expected_home.resolve()), 'QA workspace leaves the disposable home'
    binding.root.mkdir(parents=True, exist_ok=True)
    runtime = workspace.create_runtime_context(capability='chat', session_id=session_id, turn_id='qa-speech-' + uuid.uuid4().hex)
    started = time.monotonic()
    result = await asyncio.wait_for(SpeechgenTool().execute(
        text=text, language='en-US', speed=0.8, title='英语听力验收',
        _workspace_id=runtime.workspace_id,
        _workspace_dir=str(Path(runtime.output_dir) / 'media'),
    ), timeout=65)
    assert result.success, result.content
    item, = result.metadata['workspace_items']
    assert item['mime_type'].startswith('audio/'), item['mime_type']
    snapshot, _ = workspace.resolve_published_item(runtime.workspace_id, item['workspace_item_id'])
    data = snapshot.read_bytes()
    assert 1000 < len(data) < 20 * 1024**2, 'Invalid real speech byte size'
    sha = hashlib.sha256(data).hexdigest()
    event = StreamEvent(type=StreamEventType.SOURCES, metadata={'sources': result.sources})
    attachments = artifact_attachments(event)
    attachment, = attachments
    assert attachment['sha256'] == sha and attachment['generated']
    assistant_id = await store.add_message(session_id, 'assistant', content, capability='chat', attachments=attachments, parent_message_id=user_id)
    saved = await store.get_messages(session_id)
    message, = [row for row in saved if str(row['id']) == str(assistant_id)]
    assert message['attachments'][0]['sha256'] == sha, 'History did not persist the generated audio'
    return dict(session_id=session_id, message_id=assistant_id, user_message_id=user_id,
                content=content, selection_text=content, url=attachment['url'], sha256=sha,
                bytes=len(data), mime=attachment['mime_type'], filename=attachment['filename'],
                workspace_id=runtime.workspace_id, synthesis_seconds=round(time.monotonic() - started, 3),
                provider='edge', generated_html=False, paid_model_calls=0, mocked_tts=False,
                synthetic_chat_seed=True, actual_speechgen=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--expect-home', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    proof = asyncio.run(seed(args.expect_home))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(proof, ensure_ascii=False))
