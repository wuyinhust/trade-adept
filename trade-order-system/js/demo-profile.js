/** Public historical demo directory. No credentials; never an authorization source. */
export const DemoProfile = {
    // ==================== 用户数据库（密码为 SHA-256 哈希） ====================
    users: [
        {
            id: 'U001',
            username: 'David',
            name: 'David',
            role: 'admin',
            teamId: null
        },
        {
            id: 'U002',
            username: 'Lily',
            name: 'Lily',
            role: 'finance',
            teamId: null
        },
        // Team A
        {
            id: 'U003',
            username: 'Vivian',
            name: 'Vivian',
            role: 'manager',
            teamId: 'TEAM-A'
        },
        {
            id: 'U005',
            username: 'Michale',
            name: 'Michale',
            role: 'salesperson',
            teamId: 'TEAM-A'
        },
        {
            id: 'U006',
            username: 'Alex',
            name: 'Alex',
            role: 'salesperson',
            teamId: 'TEAM-A',
            visibleCompanyIds: ['CO-WY', 'CO-GW']
        },
        {
            id: 'U007',
            username: 'Anna',
            name: 'Anna',
            role: 'document',
            teamId: 'TEAM-A'
        },
        {
            id: 'U011',
            username: 'Sue',
            name: 'Sue',
            role: 'salesperson',
            teamId: 'TEAM-A',
            visibleCompanyIds: ['CO-LK']
        },
        // Team B
        {
            id: 'U004',
            username: 'Galen',
            name: 'Galen',
            role: 'manager',
            teamId: 'TEAM-B'
        },
        {
            id: 'U008',
            username: 'Nicole',
            name: 'Nicole',
            role: 'salesperson',
            teamId: 'TEAM-B'
        },
        {
            id: 'U009',
            username: 'Jack',
            name: 'Jack',
            role: 'document',
            teamId: 'TEAM-B'
        },
        {
            id: 'U010',
            username: 'Melody',
            name: 'Melody',
            role: 'document',
            teamId: 'TEAM-B'
        }
    ],

    // ==================== 团队定义 ====================
    teams: {
        'TEAM-A': {
            name: 'A组',
            managerId: 'U003',
            memberIds: ['U005', 'U006', 'U007', 'U011'],
            visibleCompanyIds: null
        },
        'TEAM-B': {
            name: 'B组',
            managerId: 'U004',
            memberIds: ['U008', 'U009', 'U010'],
            visibleCompanyIds: ['CO-WY', 'CO-GW']
        } // 为语 + Grandware HK
    }
};
