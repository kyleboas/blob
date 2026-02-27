# Blob Improvement Tasks

## Task 1: Add Aggressive Prompt Caching
**Goal**: Reduce LLM costs by 60-80% through prompt caching

**Implementation**:
- Structure all LLM calls with static content first (system prompt, tool definitions)
- Add cache control headers for Anthropic API
- Track cache hit/miss rates in logs
- Target: 90% cache hit rate on system prompts

**Files to modify**:
- `src/llm.ts` - Add caching headers and tracking
- `src/agent.ts` - Reorder prompt construction

---

## Task 2: Expand Persistent Memory to Vector Store
**Goal**: Enable Blob to recall solutions from past sessions

**Implementation**:
- Add vector embedding storage (using Cloudflare Vectorize or similar)
- Store task descriptions + solutions as embeddings
- Implement similarity search for "have I solved this before?"
- Update AGENT.md with findings from vector search

**Files to modify**:
- `src/storage.ts` - Add vector store schema
- `src/agent.ts` - Add memory search before task execution
- New: `src/memory.ts` - Vector search utilities

---

## Task 3: Evaluate TypeScript vs Python for Self-Modification
**Goal**: Assess if Blob should migrate to Python for easier self-modification

**Implementation**:
- Research: Document current pain points with TS self-modification
- Prototype: Create minimal Python agent that can modify itself
- Compare: TS compilation step vs Python exec() overhead
- Decision: Recommend stay with TS or migrate to Python

**Files to create**:
- `docs/python-migration-analysis.md`
- `experiments/self_modify_python.py` (prototype)

---

## Success Criteria
1. Cache hit rate > 80% measured in logs
2. Vector memory returns relevant past solutions > 70% of the time
3. Migration analysis provides clear recommendation with cost/benefit

**Priority**: Task 1 (cost savings) > Task 2 (capability) > Task 3 (strategic)
