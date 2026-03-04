
build:
	npm run build

install: build
	npm link @love-moon/ai-bridge

uninstall:
	npm unlink -g @love-moon/ai-bridge

publish: build
	bash scripts/publish-npm.sh
