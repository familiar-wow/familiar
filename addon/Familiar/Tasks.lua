-- Cooperative tasks: coroutines that the frame loop resumes, so waiting never blocks a frame.
local _, ns = ...

local Tasks = { frame = 0 }
ns.Tasks = Tasks

local list = {}
local clock = GetTimePreciseSec or GetTime

function Tasks.Now()
	return clock()
end

-- Yields to the next frame, or for `seconds`.
function Tasks.Sleep(seconds)
	coroutine.yield(seconds or 0)
end

-- Runs fn(...) as a task. A task that fails is reported and dropped.
function Tasks.Spawn(name, fn, ...)
	local args, n = { ... }, select("#", ...)
	list[#list + 1] = {
		name = name,
		wake = 0,
		co = coroutine.create(function()
			fn(unpack(args, 1, n))
		end),
	}
end

-- Called once per rendered frame.
function Tasks.Step()
	Tasks.frame = Tasks.frame + 1
	local now = clock()
	for i = #list, 1, -1 do
		local task = list[i]
		if now >= task.wake then
			local ok, delay = coroutine.resume(task.co)
			if not ok then
				table.remove(list, i)
				ns.Error(task.name, delay)
			elseif coroutine.status(task.co) == "dead" then
				table.remove(list, i)
			else
				task.wake = now + (delay or 0)
			end
		end
	end
end
