.PHONY: build release run clean install uninstall list-devices

BUILD_DIR := .build
INSTALL_DIR := /opt/homebrew/bin
PLIST_DIR := $(HOME)/Library/LaunchAgents
PLIST_NAME := ai.reticle.meeting-recorder.plist
LABEL := ai.reticle.meeting-recorder

build:
	swift build

release:
	swift build -c release

run: build
	$(BUILD_DIR)/debug/meeting-recorder

list-devices: build
	$(BUILD_DIR)/debug/meeting-recorder --list-devices

clean:
	swift package clean
	rm -rf $(BUILD_DIR)

install: release
	codesign --sign "Reticle Local Dev" --force $(BUILD_DIR)/release/meeting-recorder
	cp $(BUILD_DIR)/release/meeting-recorder $(INSTALL_DIR)/meeting-recorder
	cp $(PLIST_NAME) $(PLIST_DIR)/$(PLIST_NAME)
	launchctl bootstrap gui/$$(id -u) $(PLIST_DIR)/$(PLIST_NAME)

uninstall:
	-launchctl bootout gui/$$(id -u)/$(LABEL)
	rm -f $(INSTALL_DIR)/meeting-recorder
	rm -f $(PLIST_DIR)/$(PLIST_NAME)

setup-python:
	cd scripts && bash setup.sh
