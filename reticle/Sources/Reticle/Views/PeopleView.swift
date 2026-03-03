import SwiftUI

struct PeopleView: View {
    @EnvironmentObject var gateway: GatewayClient
    @State private var people: [Person] = []
    @State private var newEmail = ""
    @State private var newName = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            List {
                ForEach(people) { person in
                    PersonRow(person: person)
                }
                .onDelete { offsets in
                    for index in offsets {
                        let email = people[index].email
                        Task {
                            try? await gateway.removePerson(email: email)
                            await loadPeople()
                        }
                    }
                }
            }

            Divider()

            HStack {
                TextField("Name", text: $newName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 150)
                TextField("Email address", text: $newEmail)
                    .textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard !newEmail.isEmpty else { return }
                    Task {
                        try? await gateway.addPerson(email: newEmail, name: newName)
                        newEmail = ""
                        newName = ""
                        await loadPeople()
                    }
                }
                .disabled(newEmail.isEmpty)
            }
            .padding()
        }
        .navigationTitle("People")
        .task { await loadPeople() }
    }

    func loadPeople() async {
        people = (try? await gateway.listPeople()) ?? []
    }
}

struct PersonRow: View {
    let person: Person

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(person.name ?? person.email)
                .font(.headline)
            Text(person.email)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                IdentityBadge(label: "Slack", value: person.slackId)
                IdentityBadge(label: "Jira", value: person.jiraId)
                IdentityBadge(label: "Gmail", value: person.email)
            }
        }
        .padding(.vertical, 4)
    }
}

struct IdentityBadge: View {
    let label: String
    let value: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: value != nil ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(value != nil ? .green : .secondary)
                .imageScale(.small)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
