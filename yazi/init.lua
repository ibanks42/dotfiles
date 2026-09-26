function Linemode:custom()
	local time = math.floor(self._file.cha.mtime or 0)
	if time == 0 then
		time = ""

	elseif os.date("%Y", time) == os.date("%Y") then
		time = os.date("%m/%d/%y %I:%M %p", time)
		time = time:gsub("^0", ""):gsub("/0", "/")
	else
		time = os.date("%m/%d/%y %I:%M %p", time)
		time = time:gsub("^0", ""):gsub("/0", "/")
	end

	local size = self._file:size()
	return string.format("%s %s", size and ya.readable_size(size) or "-", time)
end
